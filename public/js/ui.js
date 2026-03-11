import { state } from "./state.js";

const currencyFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});

export function fillCategories(select, includeAll = false) {
  const options = includeAll ? ['<option value="all">All</option>'] : [];
  options.push(...state.categories.map((category) => `<option value="${category}">${category}</option>`));
  select.innerHTML = options.join("");
}

export function showStatus(element, message, type = "success") {
  element.textContent = message;
  element.className = `status-banner ${type}`;
  element.classList.remove("hidden");
}

export function clearStatus(element) {
  element.textContent = "";
  element.className = "status-banner hidden";
}

export function fillSettings(settings) {
  document.getElementById("settings-sheet-id").value = settings.googleSheetsSpreadsheetId || "";
  document.getElementById("settings-discord-webhook").value = settings.discordWebhookUrl || "";
}

export function setHeroMeta() {
  document.getElementById("sheet-status").textContent = state.googleSheetsConfigured
    ? "Connected"
    : state.googleSheetsConfigReason || "Not configured";
  document.getElementById("locale-status").textContent = state.geminiConfigured
    ? "ID / Gemini on"
    : "ID / Gemini off";
  document.getElementById("discord-status").textContent = state.discordUploadsConfigured
    ? "Webhook on"
    : state.settings.discordWebhookUrl
      ? state.discordUploadsConfigReason || "Webhook off"
      : "Local storage";
}

export function renderDraftFeedback(draft) {
  const feedback = document.getElementById("scan-feedback");
  if (!draft) {
    feedback.classList.add("hidden");
    return;
  }

  document.getElementById("scan-confidence").textContent = `Confidence: ${Math.round((draft.confidence || 0) * 100)}%`;
  const issues = Array.isArray(draft.issues) && draft.issues.length > 0 ? draft.issues.join(" ") : "No scan warnings.";
  document.getElementById("scan-issues").textContent = issues;
  feedback.classList.remove("hidden");
}

export function fillEditor(record) {
  document.getElementById("merchant").value = record?.merchant || "";
  document.getElementById("transactionDate").value = record?.transactionDate || new Date().toISOString().slice(0, 10);
  document.getElementById("amountTotal").value = record?.amountTotal ?? "";
  document.getElementById("currency").value = record?.currency || "IDR";
  document.getElementById("category").value = record?.category || "Other";
  document.getElementById("notes").value = record?.notes || "";
}

export function setEditorMode({ title, stateLabel, submitLabel }) {
  document.getElementById("editor-title").textContent = title;
  document.getElementById("review-state").textContent = stateLabel;
  document.getElementById("save-btn").textContent = submitLabel;
}

export function setListLoading(isLoading) {
  document.getElementById("list-loading").classList.toggle("hidden", !isLoading);
}

export function renderExpenses(items) {
  const body = document.getElementById("expense-table");
  const empty = document.getElementById("expense-empty");

  if (items.length === 0) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  body.innerHTML = items
    .map((expense) => {
      const amount = currencyFormatter.format(expense.amountTotal || 0);

      return `
        <tr>
          <td class="expense-cell">
            <div class="expense-title">${escapeHtml(expense.merchant)}</div>
            <div class="expense-note">${escapeHtml(expense.notes || "")}</div>
          </td>
          <td>${escapeHtml(expense.transactionDate)}</td>
          <td class="amount">${amount}</td>
          <td>${escapeHtml(expense.category)}</td>
          <td>
            <div class="actions actions-end">
              <button class="table-action" data-action="edit" data-id="${expense.id}" type="button">Edit</button>
              <button class="table-action danger-button" data-action="delete" data-id="${expense.id}" type="button">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

export function renderPagination() {
  const { page, totalPages } = state.pagination;
  document.getElementById("page-label").textContent = `${page} / ${totalPages}`;
  document.getElementById("prev-page-btn").disabled = page <= 1;
  document.getElementById("next-page-btn").disabled = page >= totalPages;
}

export function renderStats(items) {
  const total = items.reduce((sum, item) => sum + item.amountTotal, 0);
  const now = new Date();
  const monthTotal = items
    .filter((item) => {
      const date = new Date(item.transactionDate);
      return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
    })
    .reduce((sum, item) => sum + item.amountTotal, 0);
  const pending = items.filter((item) => item.syncStatus === "pending" || item.syncStatus === "error").length;

  document.getElementById("stat-total").textContent = currencyFormatter.format(total);
  document.getElementById("stat-month").textContent = currencyFormatter.format(monthTotal);
  document.getElementById("stat-count").textContent = String(items.length);
  document.getElementById("stat-pending").textContent = String(pending);
}

export function updatePreview(upload) {
  const previewCard = document.getElementById("preview-card");
  if (!upload) {
    previewCard.classList.add("hidden");
    document.getElementById("preview-image").src = "";
    document.getElementById("scan-provider").textContent = "No file";
    return;
  }

  document.getElementById("preview-image").src = upload.previewUrl;
  document.getElementById("scan-provider").textContent = upload.label;
  previewCard.classList.remove("hidden");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
