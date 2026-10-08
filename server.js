require("dotenv").config();
const {
  loadUserConfig,
  saveUserConfig,
} = require("./server/services/config.cjs");
const { parseApiKeys } = require("./server/services/api-keys.cjs");
const {
  MEDIA_CACHE_DIR,
  loadReceiptCache,
  saveReceiptCache,
  loadSettlementHistory,
  saveSettlementHistory,
} = require("./server/services/storage.cjs");
const {
  tagFuzzyDuplicates,
  calculateSettlement,
  calculateCentralSettlement,
  formatWhatsAppReport,
} = require("./server/services/settlement.cjs");
const { downloadMediaBuffer } = require("./server/services/media.cjs");
const detectSettlementCycles = (groupId) =>
  require("./server/services/cycles.cjs").detectSettlementCycles(
    groupId,
    client,
  );
const parseReceiptWithGemini = (data, mime, key, options) =>
  require("./server/services/ocr.cjs").parseReceiptWithGemini(
    data,
    mime,
    key,
    geminiApiKeys,
    options,
  );

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const QRCode = require("qrcode");
const { Client, LocalAuth, Message, MessageMedia } = require("whatsapp-web.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;

// Upgrade legacy date-keyed cycles before the app begins serving them. The
// migration writes a one-time backup and leaves ambiguous records unresolved.
require("./server/services/library.cjs").migrateSettlementCycles({
  groupStartDates: loadUserConfig().groupStartDates || {},
});

function loadEnvApiKeys() {
  const collected = [];

  // 1. Numbered environment variables: GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.
  for (let i = 1; i <= 20; i++) {
    const keyWithUnderscore = process.env[`GEMINI_API_KEY_${i}`];
    const keyWithoutUnderscore = process.env[`GEMINI_API_KEY${i}`];
    if (keyWithUnderscore) collected.push(...parseApiKeys(keyWithUnderscore));
    if (keyWithoutUnderscore)
      collected.push(...parseApiKeys(keyWithoutUnderscore));
  }

  // 2. Comma-separated list or single environment variable
  if (process.env.GEMINI_API_KEYS) {
    collected.push(...parseApiKeys(process.env.GEMINI_API_KEYS));
  }
  if (process.env.GEMINI_API_KEY) {
    collected.push(...parseApiKeys(process.env.GEMINI_API_KEY));
  }

  return Array.from(new Set(collected));
}

let geminiApiKeys = loadEnvApiKeys();
let geminiApiKey = geminiApiKeys[0] || "";

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

// -----------------------------------------------------------------------------
// State Management
// -----------------------------------------------------------------------------
let client = null;
let clientStatus = "DISCONNECTED"; // DISCONNECTED | INITIALIZING | QR_READY | AUTHENTICATED | READY | AUTH_FAILURE
let lastQrRaw = null;
let lastQrDataUrl = null;
let connectedUser = null;
const scanManager = require("./server/sockets/scan.cjs").createScanManager(
  io,
  () => ({ client, clientStatus, geminiApiKeys, geminiApiKey }),
  { detectSettlementCycles, downloadMediaBuffer, parseReceiptWithGemini },
);

// A WhatsApp/puppeteer hiccup must never take the whole local server down.
function reportWhatsAppError(origin, err) {
  const message = err?.message || String(err);
  console.error(`[Server] Recovered from ${origin}:`, message);
  if (clientStatus !== "DISCONNECTED") {
    clientStatus = "DISCONNECTED";
    connectedUser = null;
    io.emit("client:status", {
      status: clientStatus,
      error: `WhatsApp connection was interrupted (${message}). Reconnect from Settings.`,
    });
  }
}
process.on("uncaughtException", (err) => reportWhatsAppError("uncaught exception", err));
process.on("unhandledRejection", (err) => reportWhatsAppError("unhandled rejection", err));

// -----------------------------------------------------------------------------
// WhatsApp Client Lifecycle
// -----------------------------------------------------------------------------
function initializeWhatsAppClient() {
  if (client) {
    try {
      client.destroy();
    } catch (e) {
      console.warn("Error destroying existing client:", e.message);
    }
  }

  clientStatus = "INITIALIZING";
  lastQrRaw = null;
  lastQrDataUrl = null;
  connectedUser = null;
  io.emit("client:status", { status: clientStatus });

  const sessionDataPath = process.env.SESSION_DATA_PATH || "./.wwebjs_auth";

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.resolve(__dirname, sessionDataPath),
    }),
    puppeteer: {
      headless: true,
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

  client.on("qr", async (qr) => {
    clientStatus = "QR_READY";
    lastQrRaw = qr;
    try {
      lastQrDataUrl = await QRCode.toDataURL(qr, {
        margin: 2,
        width: 300,
        color: { dark: "#000000", light: "#ffffff" },
      });
    } catch (err) {
      console.error("QR code generation error:", err);
    }
    console.log("[WhatsApp] QR code generated. Waiting for device scan...");
    io.emit("client:qr", {
      raw: lastQrRaw,
      dataUrl: lastQrDataUrl,
      status: clientStatus,
    });
  });

  client.on("authenticated", () => {
    clientStatus = "AUTHENTICATED";
    console.log("[WhatsApp] Authenticated successfully.");
    io.emit("client:status", { status: clientStatus });
  });

  client.on("ready", async () => {
    clientStatus = "READY";
    connectedUser = client.info
      ? {
          pushname: client.info.pushname,
          wid: client.info.wid?.user,
          platform: client.info.platform,
        }
      : null;
    console.log(
      `[WhatsApp] Ready! Connected as: ${connectedUser ? connectedUser.pushname : "User"}`,
    );
    io.emit("client:ready", {
      status: clientStatus,
      user: connectedUser,
    });
    scanManager.resumePending().catch((error) =>
      console.error("[Scan] Could not resume durable job:", error.message),
    );
  });

  client.on("auth_failure", (msg) => {
    clientStatus = "AUTH_FAILURE";
    console.error("[WhatsApp] Authentication failure:", msg);
    io.emit("client:status", { status: clientStatus, error: msg });
  });

  client.on("disconnected", (reason) => {
    clientStatus = "DISCONNECTED";
    console.warn("[WhatsApp] Client disconnected:", reason);
    io.emit("client:status", { status: clientStatus, reason });
  });

  client.initialize().catch((err) => {
    clientStatus = "ERROR";
    console.error("[WhatsApp] Initialization error:", err.message);
    io.emit("client:status", { status: "ERROR", error: err.message });
  });
}

// -----------------------------------------------------------------------------
// Socket.io Events & API
// -----------------------------------------------------------------------------
// On-demand media endpoint with high-speed disk caching
app.get("/api/media", async (req, res) => {
  const { id, groupId } = req.query;
  if (!id) return res.status(400).send("Missing message ID");

  const safeFilename = id.replace(/[^a-zA-Z0-9_-]/g, "_") + ".jpg";
  const diskPath = path.join(MEDIA_CACHE_DIR, safeFilename);

  if (fs.existsSync(diskPath)) {
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Content-Type", "image/jpeg");
    return res.sendFile(diskPath);
  }

  if (!client || clientStatus !== "READY") {
    return res.status(503).send("WhatsApp client not ready");
  }

  try {
    const media = await downloadMediaBuffer(client, id, groupId);
    if (media && media.data) {
      const buffer = Buffer.from(media.data, "base64");
      try {
        fs.writeFileSync(diskPath, buffer);
      } catch (e) {}
      res.set("Cache-Control", "public, max-age=86400");
      res.set("Content-Type", media.mimetype || "image/jpeg");
      return res.send(buffer);
    }
  } catch (err) {
    console.warn("[API:Media] Error downloading media for", id, err.message);
  }

  return res.status(404).send("Media not available");
});

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Send initial state to newly connected frontend
  const currentConfig = loadUserConfig();
  socket.emit("init:state", {
    status: clientStatus,
    qrDataUrl: lastQrDataUrl,
    qrRaw: lastQrRaw,
    user: connectedUser,
    hasGeminiKey: geminiApiKeys.length > 0 || Boolean(geminiApiKey),
    keyCount: geminiApiKeys.length || (geminiApiKey ? 1 : 0),
    config: currentConfig,
  });

  // Save custom aliases permanently
  socket.on("config:save_aliases", ({ groupId, aliases }) => {
    saveUserConfig({ aliases });
    console.log("[Config] Aliases saved permanently to user_config.json.");
  });

  // Save default group permanently
  socket.on("config:set_default_group", ({ groupId, groupName }) => {
    saveUserConfig({ defaultGroupId: groupId, defaultGroupName: groupName });
    console.log(
      `[Config] Default group saved permanently as: ${groupName} (${groupId})`,
    );
  });

  // Re-pair / Reconnect WhatsApp request (debounced while already initializing)
  socket.on("whatsapp:reconnect", () => {
    if (clientStatus === "INITIALIZING") {
      console.log("[WhatsApp] Reconnect ignored; initialization already running.");
      return;
    }
    console.log("[WhatsApp] Reconnect requested by user.");
    initializeWhatsAppClient();
  });

  // Logout / clear session
  socket.on("whatsapp:logout", async () => {
    console.log("[WhatsApp] Logout requested.");
    if (client) {
      try {
        await client.logout();
      } catch (err) {
        console.warn("Logout error:", err.message);
      }
      try {
        await client.destroy();
      } catch (err) {}
    }
    client = null;
    clientStatus = "DISCONNECTED";
    lastQrRaw = null;
    lastQrDataUrl = null;
    connectedUser = null;
    io.emit("client:status", { status: "DISCONNECTED" });
  });

  // Update Gemini Keys on-the-fly (multi-key turbo)
  socket.on("config:set_gemini_keys", ({ keys }) => {
    if (typeof keys !== "string" || keys.length > 65536) {
      socket.emit("config:keys_error", {
        message: "Paste a valid key list smaller than 64 KB.",
      });
      return;
    }
    const parsedKeys = parseApiKeys(keys);
    const count = parsedKeys.length;
    if (!count) {
      socket.emit("config:keys_error", {
        message:
          "No Gemini keys were found. Use one key per line or GEMINI_API_KEY_1=value.",
      });
      return;
    }
    geminiApiKeys = parsedKeys;
    geminiApiKey = geminiApiKeys[0];
    console.log(
      `[Config] Updated Gemini API keys: ${count} active key(s). (Multi-Key Turbo: ${Math.min(Math.max(count, 1), 4)}x)`,
    );
    io.emit("config:keys_updated", {
      hasKeys: count > 0,
      hasGeminiKey: count > 0,
      hasKey: count > 0,
      keyCount: count,
    });
  });

  // Backward-compatible single key update
  socket.on("config:set_gemini_key", ({ key }) => {
    const keys = parseApiKeys(key);
    geminiApiKeys = keys;
    geminiApiKey = geminiApiKeys[0] || "";
    const count = geminiApiKeys.length;
    console.log(`[Config] Updated Gemini API key: ${count} active key(s).`);
    io.emit("config:key_updated", {
      hasGeminiKey: count > 0,
      hasKey: count > 0,
      keyCount: count,
    });
  });

  require("./server/sockets/history.cjs")(socket, io);

  require("./server/sockets/groups.cjs")(
    socket,
    () => ({ client, clientStatus }),
    { loadUserConfig, detectSettlementCycles, downloadMediaBuffer },
  );

  scanManager.registerSocket(socket);

  // Dynamic recalculation when frontend user edits amounts, merchants, or adds manual items
  socket.on(
    "recalculate:settlement",
    ({ expenses, aliases, startDate, endDate }) => {
      const settlement = calculateSettlement(expenses, aliases);
      const reportText = formatWhatsAppReport({
        startDate,
        endDate,
        totalPool: settlement.totalPool,
        fairShare: settlement.fairShare,
        transfers: settlement.transfers,
      });
      socket.emit("settlement:updated", { settlement, reportText });
    },
  );
});

// -----------------------------------------------------------------------------
// Start Server & Initialize WhatsApp
// -----------------------------------------------------------------------------
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n========================================================`);
  console.log(`🚀 SplitMate - WhatsApp Group Bill Splitter`);
  console.log(`🌐 Running at: http://localhost:${PORT}`);
  const keyCount = geminiApiKeys.length || (geminiApiKey ? 1 : 0);
  console.log(
    `🔑 Gemini Key(s) configured: ${keyCount > 0 ? `${keyCount} key(s) (${keyCount > 1 ? "⚡ Multi-Key Turbo Active" : "Standard"})` : "NO (Add in Settings or .env)"}`,
  );
  const database = require("./server/services/database.cjs");
  const stored = database.counts();
  console.log(
    `💾 SQLite verified: ${stored.receipts} receipts, ${stored.cycles} cycles, ${stored.history} history records`,
  );
  console.log(`🛟 Latest verified backup: ${database.latestBackup}`);
  console.log(`========================================================\n`);

  if (process.env.SPLITMATE_NO_WHATSAPP !== "1") initializeWhatsAppClient();
});
