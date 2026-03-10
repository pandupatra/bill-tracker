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

export function setHeroMeta() {
  document.getElementById("sheet-status").textContent = state.googleSheetsConfigured
    ? "Connected"
    : state.googleSheetsConfigReason || "Not configured";
  document.getElementById("locale-status").textContent = state.geminiConfigured
    ? "ID locale · Gemini ready"
    : "ID locale · Gemini missing key";
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
      const syncClass =
        expense.syncStatus === "synced"
          ? "synced"
          : expense.syncStatus === "error"
            ? "error"
            : expense.syncStatus === "skipped"
              ? "skipped"
              : "";

      return `
        <tr>
          <td>
            <strong>${escapeHtml(expense.merchant)}</strong>
            <div>${escapeHtml(expense.notes || "")}</div>
          </td>
          <td>${escapeHtml(expense.transactionDate)}</td>
          <td class="amount">${amount}</td>
          <td>${escapeHtml(expense.category)}</td>
          <td><span class="status-dot ${syncClass}">${escapeHtml(expense.syncStatus)}</span></td>
          <td>
            <div class="actions">
              <button class="table-action" data-action="edit" data-id="${expense.id}" type="button">Edit</button>
              <button class="sync-button" data-action="sync" data-id="${expense.id}" type="button">Sync</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

export function renderPagination() {
  const { page, totalPages } = state.pagination;
  document.getElementById("page-label").textContent = `Page ${page} of ${totalPages}`;
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
    document.getElementById("scan-provider").textContent = "Waiting for scan";
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
