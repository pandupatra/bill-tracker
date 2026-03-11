import {
  createExpense,
  deleteExpense,
  getMeta,
  listExpenses,
  scanReceipt,
  setRuntimeSettings,
  updateExpense
} from "./api.js";
import { resetDraft, state } from "./state.js";
import {
  clearStatus,
  fillCategories,
  fillEditor,
  fillSettings,
  renderDraftFeedback,
  renderExpenses,
  renderPagination,
  renderStats,
  setEditorMode,
  setHeroMeta,
  setListLoading,
  showStatus,
  updatePreview
} from "./ui.js";

const scanStatus = document.getElementById("scan-status");
const settingsStatus = document.getElementById("settings-status");
const receiptInput = document.getElementById("receipt-input");
const dropzone = document.getElementById("dropzone");
const SETTINGS_STORAGE_KEY = "bill-tracker.settings";

async function bootstrap() {
  const storedSettings = readStoredSettings();
  setRuntimeSettings(storedSettings);
  const meta = await getMeta();
  applyMeta(meta);

  fillCategories(document.getElementById("category"));
  fillCategories(document.getElementById("filter-category"), true);
  document.getElementById("currency").value = meta.defaultCurrency;
  document.getElementById("transactionDate").value = new Date().toISOString().slice(0, 10);
  setEditorForCreate();
  bindEvents();
  await refreshExpenses();
}

function bindEvents() {
  document.getElementById("settings-form").addEventListener("submit", onSaveSettings);
  document.getElementById("scan-form").addEventListener("submit", onScanSubmit);
  document.getElementById("expense-form").addEventListener("submit", onSaveExpense);
  document.getElementById("clear-upload-btn").addEventListener("click", clearUpload);
  document.getElementById("cancel-edit-btn").addEventListener("click", resetEditor);
  document.getElementById("refresh-btn").addEventListener("click", refreshExpenses);
  document.getElementById("new-expense-btn").addEventListener("click", resetEditor);
  document.getElementById("prev-page-btn").addEventListener("click", async () => {
    if (state.pagination.page > 1) {
      state.pagination.page -= 1;
      await refreshExpenses();
    }
  });
  document.getElementById("next-page-btn").addEventListener("click", async () => {
    if (state.pagination.page < state.pagination.totalPages) {
      state.pagination.page += 1;
      await refreshExpenses();
    }
  });
  document.getElementById("search-input").addEventListener("input", debounce(async (event) => {
    state.filters.search = event.target.value;
    state.pagination.page = 1;
    await refreshExpenses();
  }, 250));
  document.getElementById("filter-category").addEventListener("change", async (event) => {
    state.filters.category = event.target.value;
    state.pagination.page = 1;
    await refreshExpenses();
  });
  document.getElementById("expense-table").addEventListener("click", onTableAction);

  receiptInput.addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) {
      setUpload(file);
    }
  });

  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
    const [file] = event.dataTransfer.files;
    if (file) {
      receiptInput.files = event.dataTransfer.files;
      setUpload(file);
    }
  });
}

function applyMeta(meta) {
  state.categories = meta.categories;
  state.googleSheetsConfigured = meta.googleSheetsConfigured;
  state.googleSheetsConfigReason = meta.googleSheetsConfigReason || "";
  state.discordUploadsConfigured = meta.discordUploadsConfigured;
  state.discordUploadsConfigReason = meta.discordUploadsConfigReason || "";
  state.geminiConfigured = meta.geminiConfigured;
  state.settings = {
    googleSheetsSpreadsheetId: meta.settings?.googleSheetsSpreadsheetId || "",
    discordWebhookUrl: meta.settings?.discordWebhookUrl || ""
  };
  fillSettings(state.settings);
  setHeroMeta();
}

async function onSaveSettings(event) {
  event.preventDefault();

  try {
    showStatus(settingsStatus, "Saving config...", "success");
    const nextSettings = {
      googleSheetsSpreadsheetId: document.getElementById("settings-sheet-id").value.trim(),
      discordWebhookUrl: document.getElementById("settings-discord-webhook").value.trim()
    };

    if (nextSettings.discordWebhookUrl) {
      try {
        new URL(nextSettings.discordWebhookUrl);
      } catch {
        throw new Error("Discord webhook URL is invalid.");
      }
    }

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
    setRuntimeSettings(nextSettings);
    const meta = await getMeta();
    applyMeta(meta);
    showStatus(settingsStatus, "Saved on this device.", "success");
  } catch (error) {
    showStatus(settingsStatus, error.message, "error");
  }
}

function readStoredSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        googleSheetsSpreadsheetId: "",
        discordWebhookUrl: ""
      };
    }

    const parsed = JSON.parse(raw);
    return {
      googleSheetsSpreadsheetId: String(parsed.googleSheetsSpreadsheetId || "").trim(),
      discordWebhookUrl: String(parsed.discordWebhookUrl || "").trim()
    };
  } catch {
    return {
      googleSheetsSpreadsheetId: "",
      discordWebhookUrl: ""
    };
  }
}

function setUpload(file) {
  state.currentUpload = {
    file,
    previewUrl: URL.createObjectURL(file),
    label: `Ready: ${file.name}`
  };
  updatePreview(state.currentUpload);
  clearStatus(scanStatus);
}

async function onScanSubmit(event) {
  event.preventDefault();
  if (!state.currentUpload?.file) {
    showStatus(scanStatus, "Choose a receipt image before scanning.", "error");
    return;
  }

  try {
    showStatus(scanStatus, "Scanning...", "success");
    const result = await scanReceipt(state.currentUpload.file);
    state.currentDraft = result;
    state.editingExpenseId = null;

    fillEditor(result.draft);
    renderDraftFeedback(result);
    setEditorMode({
      title: "Review scan",
      stateLabel: "Scanned",
      submitLabel: "Save"
    });
    state.currentUpload.label = `Provider: ${result.provider}`;
    updatePreview(state.currentUpload);
    showStatus(scanStatus, "Scan ready.", "success");
  } catch (error) {
    showStatus(scanStatus, error.message, "error");
  }
}

async function onSaveExpense(event) {
  event.preventDefault();
  const payload = readForm();

  try {
    if (state.editingExpenseId) {
      await updateExpense(state.editingExpenseId, payload);
      showStatus(
        scanStatus,
        state.googleSheetsConfigured ? "Updated in sheet." : "Expense updated.",
        "success"
      );
    } else {
      await createExpense({
        ...payload,
        scanId: state.currentDraft?.scanId || null,
        sourceImage: state.currentDraft?.sourceImage || "",
        autoSync: true
      });
      showStatus(
        scanStatus,
        state.googleSheetsConfigured
          ? "Saved to sheet."
          : "Saved locally.",
        "success"
      );
    }

    resetEditor();
    await refreshExpenses();
  } catch (error) {
    showStatus(scanStatus, error.message, "error");
  }
}

function readForm() {
  return {
    merchant: document.getElementById("merchant").value.trim(),
    transactionDate: document.getElementById("transactionDate").value,
    amountTotal: document.getElementById("amountTotal").value,
    currency: document.getElementById("currency").value.trim() || "IDR",
    category: document.getElementById("category").value,
    notes: document.getElementById("notes").value.trim()
  };
}

async function refreshExpenses() {
  setListLoading(true);

  try {
    const result = await listExpenses({
      page: state.pagination.page,
      pageSize: state.pagination.pageSize,
      search: state.filters.search,
      category: state.filters.category,
      syncStatus: state.filters.syncStatus
    });

    state.expenses = result.items;
    state.pagination = result.pagination;
    renderExpenses(result.items);
    renderPagination();

    const summaryResult = await listExpenses({
      page: 1,
      pageSize: 1000,
      search: "",
      category: "all",
      syncStatus: "all"
    });
    renderStats(summaryResult.items);
  } finally {
    setListLoading(false);
  }
}

async function onTableAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const expense = state.expenses.find((item) => item.id === button.dataset.id);
  if (!expense) {
    return;
  }

  if (button.dataset.action === "edit") {
    state.editingExpenseId = expense.id;
    state.currentDraft = {
      scanId: expense.scanId,
      sourceImage: expense.sourceImage
    };
    fillEditor(expense);
    renderDraftFeedback(null);
    setEditorMode({
      title: `Edit ${expense.merchant}`,
      stateLabel: "Edit",
      submitLabel: "Update"
    });
    if (expense.sourceImage) {
      state.currentUpload = {
        file: null,
        previewUrl: expense.sourceImage,
        label: expense.scanStatus === "manual" ? "Manual entry" : "Saved source image"
      };
      updatePreview(state.currentUpload);
    }
    clearStatus(scanStatus);
    return;
  }

  if (button.dataset.action === "delete") {
    const confirmed = window.confirm(`Delete expense "${expense.merchant}"?`);
    if (!confirmed) {
      return;
    }

    try {
      await deleteExpense(expense.id);
      if (state.editingExpenseId === expense.id) {
        resetEditor();
      }
      showStatus(
        scanStatus,
        state.googleSheetsConfigured ? "Deleted from sheet." : "Expense deleted.",
        "success"
      );
      await refreshExpenses();
    } catch (error) {
      showStatus(scanStatus, error.message, "error");
    }
    return;
  }

}

function resetEditor() {
  clearUpload();
  resetDraft();
  setEditorForCreate();
  fillEditor({
    merchant: "",
    transactionDate: new Date().toISOString().slice(0, 10),
    amountTotal: "",
    currency: "IDR",
    category: "Other",
    notes: ""
  });
  renderDraftFeedback(null);
}

function setEditorForCreate() {
  setEditorMode({
    title: "Create expense",
    stateLabel: "Draft",
    submitLabel: "Save"
  });
}

function clearUpload() {
  if (state.currentUpload?.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(state.currentUpload.previewUrl);
  }
  receiptInput.value = "";
  state.currentUpload = null;
  updatePreview(null);
}

function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), delay);
  };
}

bootstrap().catch((error) => {
  showStatus(scanStatus, error.message, "error");
});
