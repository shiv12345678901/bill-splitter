const IMAGE_MIME = /^image\/(?:jpeg|jpg|png|webp|heic|heif)$/i;

function messageType(message = {}) {
  return String(message.type || message._data?.type || "").trim().toLowerCase();
}

function messageMimeType(message = {}) {
  return String(
    message.mimetype ||
    message.mediaData?.mimetype ||
    message.mediaData?.fullMimetype ||
    message._data?.mimetype ||
    "",
  ).split(";")[0].trim().toLowerCase();
}

function isGenuineImageMessage(message = {}) {
  if (message.isNotification) return false;
  const type = messageType(message);
  const mime = messageMimeType(message);

  // WhatsApp system records such as `group-history` may expose mediaData,
  // but they are not user-sent images. A declared non-image type always wins.
  if (type && type !== "image") return false;
  if (mime && !IMAGE_MIME.test(mime)) return false;
  return type === "image" || IMAGE_MIME.test(mime);
}

module.exports = { isGenuineImageMessage, messageMimeType, messageType };
