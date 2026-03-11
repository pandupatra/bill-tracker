import { google } from "googleapis";

function getSpreadsheetId(config = {}) {
  return config.googleSheetsSpreadsheetId || process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "";
}

function getServiceAccountEmail(config = {}) {
  return config.googleServiceAccountEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
}

function getServiceAccountPrivateKey(config = {}) {
  return config.googleServiceAccountPrivateKey || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
}

function getAuth(config = {}) {
  const state = getGoogleSheetsConfigState(config);
  if (!state.configured) {
    return null;
  }

  const email = getServiceAccountEmail(config);
  const privateKey = getServiceAccountPrivateKey(config)?.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

export function getGoogleSheetsConfigState(config = {}) {
  const spreadsheetId = getSpreadsheetId(config);
  const email = getServiceAccountEmail(config);
  const privateKey = getServiceAccountPrivateKey(config);

  if (!spreadsheetId) {
    return { configured: false, reason: "Missing spreadsheet ID." };
  }

  if (!email) {
    return { configured: false, reason: "Missing service account email." };
  }

  if (!privateKey) {
    return { configured: false, reason: "Missing service account private key." };
  }

  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    return {
      configured: false,
      reason: "Invalid service account private key format."
    };
  }

  return { configured: true, reason: "" };
}

export function isGoogleSheetsConfigured(config = {}) {
  return getGoogleSheetsConfigState(config).configured;
}

function getClient(config = {}) {
  const auth = getAuth(config);
  if (!auth || !getSpreadsheetId(config)) {
    return null;
  }
  return google.sheets({ version: "v4", auth });
}

function getSheetName(config = {}) {
  return config.googleSheetsSheetName || process.env.GOOGLE_SHEETS_SHEET_NAME || "Expenses";
}

async function getSheetTabId(client, config = {}) {
  const response = await client.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(config),
    fields: "sheets(properties(sheetId,title))"
  });

  const targetTitle = getSheetName(config);
  const sheets = Array.isArray(response.data.sheets) ? response.data.sheets : [];
  const match = sheets.find((sheet) => sheet.properties?.title === targetTitle);
  const sheetId = match?.properties?.sheetId;

  if (sheetId === undefined || sheetId === null) {
    throw new Error(`Google Sheets tab "${targetTitle}" was not found.`);
  }

  return sheetId;
}

function toRow(expense) {
  return [
    expense.id,
    expense.merchant,
    expense.transactionDate,
    expense.amountTotal,
    expense.currency,
    expense.category,
    expense.notes,
    expense.sourceImage || "",
    expense.scanId || "",
    expense.scanStatus || "",
    expense.reviewStatus || "",
    expense.reviewedAt || "",
    expense.syncStatus,
    expense.syncError || "",
    expense.createdAt || "",
    expense.updatedAt || ""
  ];
}

function parseRowNumber(updatedRange) {
  const match = updatedRange?.match(/![A-Z]+(\d+):[A-Z]+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeAmount(value) {
  const numeric = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function toIsoDate(value, fallback = "") {
  const text = normalizeText(value);
  if (!text) {
    return fallback;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return fallback || text;
  }

  return date.toISOString();
}

function fromRow(row, rowNumber) {
  const [
    id,
    merchant,
    transactionDate,
    amountTotal,
    currency,
    category,
    notes,
    sourceImage,
    scanId = "",
    scanStatus = "",
    reviewStatus = "",
    reviewedAt = "",
    syncStatus = "",
    syncError = "",
    createdAt = "",
    updatedAt = ""
  ] = row;

  const normalizedId = normalizeText(id);
  if (!normalizedId || normalizedId.toLowerCase() === "id") {
    return null;
  }

  const normalizedReviewedAt = toIsoDate(reviewedAt);
  const normalizedCreatedAt = toIsoDate(createdAt, normalizedReviewedAt);
  const normalizedUpdatedAt = toIsoDate(updatedAt, normalizedReviewedAt || normalizedCreatedAt);

  return {
    id: normalizedId,
    merchant: normalizeText(merchant) || "Unknown",
    transactionDate: normalizeText(transactionDate),
    amountTotal: normalizeAmount(amountTotal),
    currency: normalizeText(currency) || "IDR",
    category: normalizeText(category) || "Other",
    notes: normalizeText(notes),
    sourceImage: normalizeText(sourceImage),
    scanId: normalizeText(scanId) || null,
    scanStatus: normalizeText(scanStatus) || (normalizeText(sourceImage) ? "scanned" : "manual"),
    reviewStatus: normalizeText(reviewStatus) || "approved",
    reviewedAt: normalizedReviewedAt || normalizedCreatedAt || new Date().toISOString(),
    syncStatus: normalizeText(syncStatus) || "synced",
    syncError: normalizeText(syncError),
    createdAt: normalizedCreatedAt || normalizedReviewedAt || new Date().toISOString(),
    updatedAt: normalizedUpdatedAt || normalizedCreatedAt || normalizedReviewedAt || new Date().toISOString(),
    sheetRowNumber: rowNumber
  };
}

export async function listExpensesFromSheet(config = {}) {
  const client = getClient(config);
  if (!client) {
    return [];
  }

  const response = await client.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(config),
    range: `${getSheetName(config)}!A:P`
  });

  const rows = Array.isArray(response.data.values) ? response.data.values : [];
  return rows
    .map((row, index) => fromRow(row, index + 1))
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || left.reviewedAt || "") || 0;
      const rightTime = Date.parse(right.createdAt || right.reviewedAt || "") || 0;
      if (rightTime !== leftTime) {
        return rightTime - leftTime;
      }

      return (right.sheetRowNumber || 0) - (left.sheetRowNumber || 0);
    });
}

export async function deleteExpenseFromSheet(rowNumber, config = {}) {
  const client = getClient(config);
  if (!client) {
    throw new Error("Google Sheets is not configured.");
  }

  const sheetId = await getSheetTabId(client, config);

  await client.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(config),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: Math.max(Number(rowNumber) - 1, 0),
              endIndex: Math.max(Number(rowNumber), 0)
            }
          }
        }
      ]
    }
  });
}

export async function syncExpenseToSheet(expense, config = {}) {
  const client = getClient(config);
  if (!client) {
    return {
      syncStatus: "skipped",
      sheetRowNumber: expense.sheetRowNumber ?? null,
      syncError: "Google Sheets is not configured."
    };
  }

  const spreadsheetId = getSpreadsheetId(config);
  const sheetName = getSheetName(config);
  const values = [toRow(expense)];

  if (expense.sheetRowNumber) {
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${expense.sheetRowNumber}:P${expense.sheetRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });

    return {
      syncStatus: "synced",
      sheetRowNumber: expense.sheetRowNumber,
      syncError: ""
    };
  }

  const appendResult = await client.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:P`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values }
  });

  return {
    syncStatus: "synced",
    sheetRowNumber: parseRowNumber(appendResult.data.updates?.updatedRange),
    syncError: ""
  };
}
