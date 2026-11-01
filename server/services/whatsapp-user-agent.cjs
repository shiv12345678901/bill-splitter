const DEFAULT_WHATSAPP_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.73 Safari/537.36";

function resolveWhatsAppUserAgent(value = process.env.SPLITMATE_WHATSAPP_USER_AGENT) {
  if (value == null || value.trim() === "") return DEFAULT_WHATSAPP_USER_AGENT;
  const userAgent = value.trim();
  if (userAgent.length > 512 || /[\u0000-\u001f\u007f]/.test(userAgent)) {
    throw new Error("SPLITMATE_WHATSAPP_USER_AGENT contains invalid control characters or is too long.");
  }
  return userAgent;
}

module.exports = { DEFAULT_WHATSAPP_USER_AGENT, resolveWhatsAppUserAgent };
