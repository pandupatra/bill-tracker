function buildWebhookUrl(pathnameSuffix = "", extraParams = {}) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Discord uploads are not configured.");
  }

  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${pathnameSuffix}`;

  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  if (process.env.DISCORD_WEBHOOK_THREAD_ID) {
    url.searchParams.set("thread_id", process.env.DISCORD_WEBHOOK_THREAD_ID);
  }

  return url.toString();
}

function sanitizeFilename(filename) {
  const fallback = "receipt-upload.jpg";
  const trimmed = String(filename || "").trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/[^\w.\-() ]+/g, "_");
}

async function parseDiscordError(response) {
  const body = await response.text();
  return body || `Discord request failed with status ${response.status}.`;
}

function getAttachmentFromMessage(message, attachmentId, filename) {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
    return null;
  }

  if (attachmentId) {
    const matchById = message.attachments.find(
      (attachment) => String(attachment.id) === String(attachmentId)
    );
    if (matchById) {
      return matchById;
    }
  }

  if (filename) {
    const matchByFilename = message.attachments.find(
      (attachment) => attachment.filename === filename
    );
    if (matchByFilename) {
      return matchByFilename;
    }
  }

  return message.attachments[0] || null;
}

export function isDiscordUploadConfigured() {
  return Boolean(process.env.DISCORD_WEBHOOK_URL);
}

export function getDiscordUploadConfigState() {
  if (!process.env.DISCORD_WEBHOOK_URL) {
    return { configured: false, reason: "Missing Discord webhook URL." };
  }

  try {
    new URL(process.env.DISCORD_WEBHOOK_URL);
  } catch {
    return { configured: false, reason: "Invalid Discord webhook URL." };
  }

  return { configured: true, reason: "" };
}

export async function uploadReceiptToDiscord(file) {
  const state = getDiscordUploadConfigState();
  if (!state.configured) {
    throw new Error(state.reason);
  }

  const filename = sanitizeFilename(file.originalname);
  const formData = new FormData();
  formData.append(
    "payload_json",
    JSON.stringify({
      content: `Receipt upload: ${filename}`
    })
  );
  formData.append(
    "files[0]",
    new Blob([file.buffer], {
      type: file.mimetype || "application/octet-stream"
    }),
    filename
  );

  const response = await fetch(buildWebhookUrl("", { wait: "true" }), {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error(await parseDiscordError(response));
  }

  const message = await response.json();
  const attachment = getAttachmentFromMessage(message, null, filename);
  if (!attachment) {
    throw new Error("Discord upload succeeded but no attachment was returned.");
  }

  return {
    storage: "discord",
    publicPath: attachment.url,
    discordMessageId: String(message.id),
    discordAttachmentId: String(attachment.id),
    discordFilename: attachment.filename
  };
}

export async function getDiscordAttachmentUrl({ messageId, attachmentId, filename }) {
  const state = getDiscordUploadConfigState();
  if (!state.configured) {
    throw new Error(state.reason);
  }

  const response = await fetch(buildWebhookUrl(`/messages/${messageId}`), {
    method: "GET"
  });

  if (!response.ok) {
    throw new Error(await parseDiscordError(response));
  }

  const message = await response.json();
  const attachment = getAttachmentFromMessage(message, attachmentId, filename);
  if (!attachment?.url) {
    throw new Error("Discord attachment URL is no longer available.");
  }

  return attachment.url;
}
