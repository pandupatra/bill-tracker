import { CATEGORIES, DEFAULT_CURRENCY } from "../constants.js";

function normalizeDate(value) {
  if (!value) {
    return new Date().toISOString().slice(0, 10);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

function normalizeAmount(value) {
  const numeric = Number(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

export function validateExpenseInput(input) {
  const category = CATEGORIES.includes(input.category) ? input.category : "Other";

  return {
    merchant: String(input.merchant || "Unknown").trim() || "Unknown",
    transactionDate: normalizeDate(input.transactionDate),
    currency: String(input.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY,
    amountTotal: normalizeAmount(input.amountTotal),
    category,
    notes: String(input.notes || "").trim().slice(0, 200)
  };
}

export function normalizeScanDraft(draft) {
  return validateExpenseInput(draft);
}
