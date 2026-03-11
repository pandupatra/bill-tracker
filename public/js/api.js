let runtimeSettings = {
  googleSheetsSpreadsheetId: "",
  discordWebhookUrl: ""
};

async function request(url, options = {}) {
  const headers = new Headers(options.headers || {});

  if (runtimeSettings.googleSheetsSpreadsheetId) {
    headers.set("x-bill-tracker-sheet-id", runtimeSettings.googleSheetsSpreadsheetId);
  }

  if (runtimeSettings.discordWebhookUrl) {
    headers.set("x-bill-tracker-discord-webhook", runtimeSettings.discordWebhookUrl);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

export function setRuntimeSettings(nextSettings) {
  runtimeSettings = {
    googleSheetsSpreadsheetId: String(nextSettings.googleSheetsSpreadsheetId || "").trim(),
    discordWebhookUrl: String(nextSettings.discordWebhookUrl || "").trim()
  };
}

export function getMeta() {
  return request("/api/meta");
}

export function scanReceipt(file) {
  const formData = new FormData();
  formData.append("receipt", file);
  formData.append("locale", "id-ID");

  return request("/api/scans", {
    method: "POST",
    body: formData
  });
}

export function listExpenses(params) {
  const search = new URLSearchParams(params).toString();
  return request(`/api/expenses?${search}`);
}

export function createExpense(payload) {
  return request("/api/expenses", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export function updateExpense(id, payload) {
  return request(`/api/expenses/${id}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export function deleteExpense(id) {
  return request(`/api/expenses/${id}`, {
    method: "DELETE"
  });
}

export function syncExpense(id) {
  return request(`/api/expenses/${id}/sync`, {
    method: "POST"
  });
}
