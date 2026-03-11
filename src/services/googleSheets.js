import { google } from "googleapis";

const EXPENSE_COLUMN_COUNT = 16;
const EXPENSE_RANGE = "A:P";
const SHEET_SCAN_RANGE = "A:AD";
const LEGACY_SHIFT_START_INDEX = 14;
const LEGACY_CLEAR_RANGE = "Q:AD";

function getSpreadsheetId(config = {}) {
  return String(config.googleSheetsSpreadsheetId || "").trim();
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getFirstCellFromValues(values) {
  if (!Array.isArray(values) || values.length === 0 || !Array.isArray(values[0])) {
    return "";
  }

  return normalizeText(values[0][0]);
}

function hasAnyValue(row = []) {
  return row.some((cell) => normalizeText(cell));
}

function getCanonicalRowValues(row = []) {
  const primary = row.slice(0, EXPENSE_COLUMN_COUNT);
  const fallback = row.slice(LEGACY_SHIFT_START_INDEX, LEGACY_SHIFT_START_INDEX + EXPENSE_COLUMN_COUNT);

  if (normalizeText(primary[0])) {
    return primary;
  }

  if (normalizeText(fallback[0])) {
    return fallback;
  }

  return primary;
}

async function findRowNumberById(client, expenseId, config = {}) {
  const response = await client.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(config),
    range: `${getSheetName(config)}!${SHEET_SCAN_RANGE}`
  });

  const rows = Array.isArray(response.data.values) ? response.data.values : [];
  const matchIndex = rows.findIndex((row) => {
    const values = getCanonicalRowValues(row);
    return normalizeText(values[0]) === normalizeText(expenseId);
  });
  return matchIndex === -1 ? null : matchIndex + 1;
}

async function readExpenseByRowNumber(client, rowNumber, config = {}) {
  if (!rowNumber) {
    return null;
  }

  const response = await client.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(config),
    range: `${getSheetName(config)}!A${rowNumber}:AD${rowNumber}`
  });

  const row = Array.isArray(response.data.values) ? response.data.values[0] : null;
  return row ? fromRow(getCanonicalRowValues(row), rowNumber) : null;
}

async function getNextExpenseRowNumber(client, config = {}) {
  const response = await client.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(config),
    range: `${getSheetName(config)}!${SHEET_SCAN_RANGE}`
  });

  const rows = Array.isArray(response.data.values) ? response.data.values : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (hasAnyValue(rows[index])) {
      return index + 2;
    }
  }

  return 1;
}

async function clearLegacyShiftedCells(client, rowNumber, config = {}) {
  await client.spreadsheets.values.clear({
    spreadsheetId: getSpreadsheetId(config),
    range: `${getSheetName(config)}!${LEGACY_CLEAR_RANGE.replace("Q", `Q${rowNumber}`).replace("AD", `AD${rowNumber}`)}`
  });
}

async function resolveRowNumberWithRetry(client, expenseId, config = {}, attempts = 5, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rowNumber = await findRowNumberById(client, expenseId, config);
    if (rowNumber) {
      return rowNumber;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return null;
}

async function verifyExpenseAtRowWithRetry(client, expenseId, rowNumber, config = {}, attempts = 5, delayMs = 250) {
  if (!rowNumber) {
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const verifiedExpense = await readExpenseByRowNumber(client, rowNumber, config);
    if (verifiedExpense && normalizeText(verifiedExpense.id) === normalizeText(expenseId)) {
      return true;
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return false;
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
    range: `${getSheetName(config)}!${SHEET_SCAN_RANGE}`
  });

  const rows = Array.isArray(response.data.values) ? response.data.values : [];
  return rows
    .map((row, index) => fromRow(getCanonicalRowValues(row), index + 1))
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
  const persistedExpense = {
    ...expense,
    syncStatus: "synced",
    syncError: ""
  };
  const values = [toRow(persistedExpense)];

  if (expense.sheetRowNumber) {
    const existingRowResponse = await client.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A${expense.sheetRowNumber}:AD${expense.sheetRowNumber}`
    });
    const existingRow = Array.isArray(existingRowResponse.data.values) ? existingRowResponse.data.values[0] : [];
    const hadLegacyShift = !normalizeText(existingRow[0]) && normalizeText(existingRow[LEGACY_SHIFT_START_INDEX]);

    const updateResult = await client.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${expense.sheetRowNumber}:P${expense.sheetRowNumber}`,
      includeValuesInResponse: true,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });

    if (hadLegacyShift) {
      await clearLegacyShiftedCells(client, expense.sheetRowNumber, config);
    }

    const responseId = getFirstCellFromValues(updateResult.data.updatedData?.values);
    const verified =
      responseId === normalizeText(persistedExpense.id) ||
      await verifyExpenseAtRowWithRetry(client, persistedExpense.id, expense.sheetRowNumber, config);

    if (!verified) {
      throw new Error("Google Sheets update could not be verified.");
    }

    return {
      ...persistedExpense,
      sheetRowNumber: expense.sheetRowNumber,
    };
  }

  const nextRowNumber = await getNextExpenseRowNumber(client, config);
  const appendResult = await client.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A${nextRowNumber}:P${nextRowNumber}`,
    includeValuesInResponse: true,
    valueInputOption: "USER_ENTERED",
    requestBody: { values }
  });

  const responseId = getFirstCellFromValues(appendResult.data.updatedData?.values);
  const sheetRowNumber = nextRowNumber || await resolveRowNumberWithRetry(client, persistedExpense.id, config);

  const verified =
    responseId === normalizeText(persistedExpense.id) ||
    await verifyExpenseAtRowWithRetry(client, persistedExpense.id, sheetRowNumber, config);

  if (!verified) {
    throw new Error("Google Sheets append could not be verified.");
  }

  return {
    ...persistedExpense,
    sheetRowNumber
  };
}
