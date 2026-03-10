import { google } from "googleapis";

function getAuth() {
  const state = getGoogleSheetsConfigState();
  if (!state.configured) {
    return null;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

export function getGoogleSheetsConfigState() {
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return { configured: false, reason: "Missing spreadsheet ID." };
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    return { configured: false, reason: "Missing service account email." };
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    return { configured: false, reason: "Missing service account private key." };
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.includes("BEGIN PRIVATE KEY")) {
    return {
      configured: false,
      reason: "Invalid service account private key format."
    };
  }

  return { configured: true, reason: "" };
}

export function isGoogleSheetsConfigured() {
  return getGoogleSheetsConfigState().configured;
}

function getClient() {
  const auth = getAuth();
  if (!auth || !process.env.GOOGLE_SHEETS_SPREADSHEET_ID) {
    return null;
  }
  return google.sheets({ version: "v4", auth });
}

function getSheetName() {
  return process.env.GOOGLE_SHEETS_SHEET_NAME || "Expenses";
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
    expense.reviewedAt || "",
    expense.syncStatus,
    expense.syncError || ""
  ];
}

function parseRowNumber(updatedRange) {
  const match = updatedRange?.match(/![A-Z]+(\d+):[A-Z]+(\d+)/i);
  return match ? Number(match[1]) : null;
}

export async function syncExpenseToSheet(expense) {
  const client = getClient();
  if (!client) {
    return {
      syncStatus: "skipped",
      sheetRowNumber: expense.sheetRowNumber ?? null,
      syncError: "Google Sheets is not configured."
    };
  }

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetName = getSheetName();
  const values = [toRow(expense)];

  if (expense.sheetRowNumber) {
    await client.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${expense.sheetRowNumber}:K${expense.sheetRowNumber}`,
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
    range: `${sheetName}!A:K`,
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
