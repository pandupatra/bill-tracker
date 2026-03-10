export const state = {
  categories: [],
  googleSheetsConfigured: false,
  googleSheetsConfigReason: "",
  geminiConfigured: false,
  pagination: {
    page: 1,
    pageSize: 10,
    totalPages: 1
  },
  filters: {
    search: "",
    category: "all",
    syncStatus: "all"
  },
  expenses: [],
  currentUpload: null,
  currentDraft: null,
  editingExpenseId: null
};

export function resetDraft() {
  state.currentDraft = null;
  state.currentUpload = null;
  state.editingExpenseId = null;
}
