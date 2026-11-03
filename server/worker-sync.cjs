require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const { loadContract, createDiagnostics } = require("./services/worker-runtime.cjs");
const { EventEmitter } = require("node:events");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const { parseApiKeys } = require("./services/api-keys.cjs");
const { loadUserConfig } = require("./services/config.cjs");
const { downloadMediaBuffer } = require("./services/media.cjs");
const { parseReceiptWithGemini } = require("./services/ocr.cjs");
const { createScanManager } = require("./sockets/scan.cjs");
const { createConfiguredSupabaseWorker, LIVE_MODE } = require("./services/supabase-worker.cjs");
const { WhatsAppSessionLock, clearStaleChromiumProfileLocks } = require("./services/whatsapp-session-lock.cjs");
const { resolveWhatsAppUserAgent } = require("./services/whatsapp-user-agent.cjs");
const { attachMessageSnapshotTracker } = require("./services/whatsapp-snapshot.cjs");

function loadGeminiKeys() {
  const values = [];
  for (let i = 1; i <= 20; i++) {
    values.push(process.env[`GEMINI_API_KEY_${i}`], process.env[`GEMINI_API_KEY${i}`]);
  }
  values.push(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY);
  return Array.from(new Set(values.filter(Boolean).flatMap((value) => parseApiKeys(value))));
}

const mode = process.env.SUPABASE_WORKER_MODE || "dry-run";
const sessionDataPath = path.resolve(
  __dirname, "..",
  process.env.SESSION_DATA_PATH || "./.wwebjs_auth",
);
const geminiApiKeys = loadGeminiKeys();
const geminiApiKey = geminiApiKeys[0] || "";
const events = new EventEmitter();
let client = null;
let clientStatus = "DISCONNECTED";
let reconnectTimer = null;
let reconnectAttempt = 0;
let initializing = false;
let stopping = false;
let sessionLock = null;
let diagnostics = null;
const runtimeDir = process.env.SPLITMATE_RUNTIME_DIR || path.resolve(__dirname, "../data/run");
const qrFile = path.join(runtimeDir, "pairing-qr.txt");
const contract = loadContract(process.env.SPLITMATE_CONTRACT_FILE);
const whatsappUserAgent = resolveWhatsAppUserAgent();
const userConfig = () => ({ ...loadUserConfig(), ...(contract.approved ? { aliases: contract.value.aliases } : {}) });

const detectSettlementCycles = (groupId) =>
  require("./services/cycles.cjs").detectSettlementCycles(groupId, client);
const parseWithGemini = (data, mime, key, options) =>
  parseReceiptWithGemini(data, mime, key, [], options);

for (const event of ["scan:progress", "scan:job", "scan:error", "scan:complete"]) {
  events.on(event, (payload = {}) => {
    if (event === "scan:progress") {
      console.log(`[Scan] ${payload.message || payload.stage || "progress"}`);
    } else if (event === "scan:error") {
      console.error(`[Scan] ${payload.message || "scan error"}`);
    }
  });
}

const scanManager = createScanManager(
  events,
  () => ({ client, clientStatus, geminiApiKeys, geminiApiKey }),
  { detectSettlementCycles, downloadMediaBuffer, parseReceiptWithGemini: parseWithGemini },
);

const supabaseWorker = createConfiguredSupabaseWorker({
  scanManager,
  scanEvents: events,
  getConnection: () => ({ client, clientStatus, geminiApiKeys, geminiApiKey }),
  loadUserConfig: userConfig,
  contract,
});

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(60000, 5000 * 2 ** Math.min(reconnectAttempt - 1, 3));
  console.log(`[WhatsApp] Reconnecting in ${Math.ceil(delay / 1000)} seconds…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void initializeWhatsApp();
  }, delay);
}

async function initializeWhatsApp() {
  if (stopping || initializing || clientStatus === "READY") return;
  initializing = true;
  clientStatus = "INITIALIZING";
  try {
    if (client) {
      const previous = client;
      previous.removeAllListeners();
      await previous.destroy();
      client = null;
    }
    // The application owner lock is already held here, so Chromium's stale
    // Singleton* artifacts can be removed without risking a second client.
    clearStaleChromiumProfileLocks(sessionDataPath);
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionDataPath }),
      userAgent: whatsappUserAgent,
      webVersionCache: { type: "local", path: path.join(sessionDataPath, "web-cache") },
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-first-run",
          "--no-zygote",
        ],
      },
    });
    attachMessageSnapshotTracker(client);

    client.on("qr", async (qr) => {
      clientStatus = "QR_READY";
      try {
        if (mode !== "pair") {
          console.log("[WhatsApp] Pairing required. Stop the worker and use the documented private pairing command.");
          return;
        }
        fs.writeFileSync(qrFile, await QRCode.toString(qr, { type: "terminal", small: true }), { mode: 0o600 });
        console.log("[WhatsApp] Pairing QR available through the private container command; expires automatically.");
      } catch (error) {
        console.error("[WhatsApp] Could not render QR code:", error.message);
      }
    });
    client.on("authenticated", () => {
      clientStatus = "AUTHENTICATED";
      console.log("[WhatsApp] Authenticated.");
    });
    client.on("ready", () => {
      clientStatus = "READY";
      reconnectAttempt = 0;
      fs.rmSync(qrFile, { force: true });
      console.log("[WhatsApp] Ready. InstaBox can process claimed jobs.");
    });
    client.on("auth_failure", (message) => {
      clientStatus = "AUTH_FAILURE";
      console.error("[WhatsApp] Authentication failure:", message);
      scheduleReconnect();
    });
    client.on("disconnected", (reason) => {
      clientStatus = "DISCONNECTED";
      console.warn("[WhatsApp] Disconnected:", reason);
      scheduleReconnect();
    });
    client.on("error", (error) => {
      console.error("[WhatsApp] Client error:", error.message);
    });

    await client.initialize();
  } catch (error) {
    clientStatus = "DISCONNECTED";
    console.error("[WhatsApp] Initialization failed:", error.message);
    scheduleReconnect();
  } finally {
    initializing = false;
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 35000).unref();
  console.log(`[Worker] ${signal}; shutting down.`);
  supabaseWorker?.stop();
  diagnostics?.stop();
  fs.rmSync(qrFile, { force: true });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    await client?.destroy();
  } catch (error) {
    console.warn("[WhatsApp] Shutdown warning:", error.message);
  }
  sessionLock?.release();
  process.exit(signal === "fatal error" ? 1 : 0);
}

async function main() {
  if (!["dry-run", "pair", "live"].includes(mode)) throw new Error("Invalid SUPABASE_WORKER_MODE.");
  diagnostics = createDiagnostics(runtimeDir, () => ({
    mode, stopping, whatsapp: clientStatus, schemaVerified: supabaseWorker?.schemaVerified || false,
    contractApproved: contract.approved,
    ready: mode === "live" && !!supabaseWorker?.schemaVerified && supabaseWorker.liveWritesApproved && clientStatus === "READY" && geminiApiKeys.length > 0 && !!supabaseWorker?.diagnostics?.writesEnabled && !supabaseWorker?.diagnostics?.lastError,
    job: supabaseWorker?.diagnostics || null,
  }));
  fs.rmSync(qrFile, { force: true });
  if (mode === "pair") {
    sessionLock = new WhatsAppSessionLock(sessionDataPath, "instabox-private-pairing").acquire();
    await initializeWhatsApp();
    return;
  }
  if (!supabaseWorker) {
    throw new Error("Configure SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) before starting the worker.");
  }
  if (mode !== LIVE_MODE) {
    console.log("[Worker] Safe dry-run mode. Supabase schema will be checked; no jobs, WhatsApp session, or writes will run.");
    supabaseWorker.start();
    return;
  }
  if (!supabaseWorker.liveWritesApproved) {
    throw new Error(
      `Live mode is locked: ${contract.reason || "set both environment confirmations"}`,
    );
  }
  if (!geminiApiKeys.length || !process.env.SPLITMATE_WHATSAPP_GROUP_ID)
    throw new Error("Live mode requires Gemini keys and an explicit WhatsApp group ID.");

  sessionLock = new WhatsAppSessionLock(sessionDataPath, "instabox-sync-worker").acquire();
  supabaseWorker.start();
  await initializeWhatsApp();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[Worker] Uncaught exception:", error);
  void shutdown("fatal error");
});
process.on("exit", () => sessionLock?.release());

main().catch((error) => {
  console.error(`[Worker] ${error.message}`);
  sessionLock?.release();
  diagnostics?.stop();
  process.exitCode = 1;
});
