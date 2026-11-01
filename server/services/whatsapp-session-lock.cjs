const fs = require("node:fs");
const path = require("node:path");

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

class WhatsAppSessionLock {
  constructor(sessionDataPath, owner = "unknown") {
    this.directory = path.resolve(sessionDataPath || "./.wwebjs_auth");
    this.file = path.join(this.directory, ".splitmate-whatsapp-owner.lock");
    this.owner = owner;
    this.fd = null;
  }

  acquire() {
    fs.mkdirSync(this.directory, { recursive: true });
    try {
      this.fd = fs.openSync(this.file, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing = null;
      try {
        existing = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        throw new Error("WhatsApp owner lock is unreadable; verify no owner is running before removing it.");
      }
      if (existing?.pid && processIsAlive(Number(existing.pid))) {
        throw new Error(
          `WhatsApp session is already owned by ${existing.owner || "another process"} (PID ${existing.pid}).`,
        );
      }
      fs.rmSync(this.file, { force: true });
      this.fd = fs.openSync(this.file, "wx");
    }

    fs.writeFileSync(
      this.fd,
      JSON.stringify({ pid: process.pid, owner: this.owner, acquiredAt: new Date().toISOString() }),
      "utf8",
    );
    return this;
  }

  release() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {}
    this.fd = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch {}
  }
}

module.exports = { WhatsAppSessionLock, processIsAlive };
