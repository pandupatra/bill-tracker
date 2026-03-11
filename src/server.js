import express from "express";
import multer from "multer";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CATEGORIES, DEFAULT_CURRENCY, DEFAULT_LOCALE, PAGE_SIZE } from "./constants.js";
import { findRecord, listRecords, upsertRecord } from "./lib/store.js";
import { loadEnvFile } from "./lib/loadEnv.js";
import { normalizeScanDraft, validateExpenseInput } from "./lib/validation.js";
import {
  getDiscordUploadConfigState,
  getDiscordAttachmentUrl,
  isDiscordUploadConfigured,
  uploadReceiptToDiscord
} from "./services/discordUploads.js";
import { isGeminiConfigured, scanReceipt } from "./services/gemini.js";
import {
  deleteExpenseFromSheet,
  getGoogleSheetsConfigState,
  isGoogleSheetsConfigured,
  listExpensesFromSheet,
  syncExpenseToSheet
} from "./services/googleSheets.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const uploadsDir = path.resolve(rootDir, "data", "uploads");

loadEnvFile();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.resolve(rootDir, "public")));

function nowIso() {
  return new Date().toISOString();
}

function toPublicImagePath(filename) {
  return `/uploads/${filename}`;
}

function toScanImagePath(scanId) {
  return `/api/scans/${scanId}/source-image`;
}

async function saveLocalUpload(file) {
  await mkdir(uploadsDir, { recursive: true });
  const extension = path.extname(file.originalname) || ".jpg";
  const filename = `${randomUUID()}${extension}`;
  const absolutePath = path.join(uploadsDir, filename);
  await writeFile(absolutePath, file.buffer);
  return {
    storage: "local",
    publicPath: toPublicImagePath(filename)
  };
}

function getRequestConfig(request) {
  return {
    googleSheetsSpreadsheetId: String(request.get("x-bill-tracker-sheet-id") || "").trim(),
    discordWebhookUrl: String(request.get("x-bill-tracker-discord-webhook") || "").trim(),
    googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    googleServiceAccountPrivateKey: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "",
    googleSheetsSheetName: process.env.GOOGLE_SHEETS_SHEET_NAME || "Expenses",
    discordWebhookThreadId: process.env.DISCORD_WEBHOOK_THREAD_ID || ""
  };
}

async function saveUpload(file, config) {
  if (isDiscordUploadConfigured(config)) {
    return uploadReceiptToDiscord(file, config);
  }

  return saveLocalUpload(file);
}

function buildExpenseRecord(input, extras = {}) {
  const fields = validateExpenseInput(input);
  const timestamp = nowIso();

  return {
    id: extras.id || randomUUID(),
    merchant: fields.merchant,
    transactionDate: fields.transactionDate,
    currency: fields.currency || DEFAULT_CURRENCY,
    amountTotal: fields.amountTotal,
    category: fields.category,
    notes: fields.notes,
    sourceImage: extras.sourceImage || "",
    scanId: extras.scanId || null,
    scanStatus: extras.scanStatus || "reviewed",
    reviewStatus: extras.reviewStatus || "approved",
    syncStatus: extras.syncStatus || "pending",
    sheetRowNumber: extras.sheetRowNumber ?? null,
    syncError: extras.syncError || "",
    reviewedAt: extras.reviewedAt || timestamp,
    createdAt: extras.createdAt || timestamp,
    updatedAt: timestamp
  };
}

async function updateTrainingExample(scanId, patch) {
  if (!scanId) {
    return null;
  }

  const example = await findRecord("training-examples.json", scanId);
  if (!example) {
    return null;
  }

  const updated = {
    ...example,
    ...patch,
    updatedAt: nowIso()
  };
  await upsertRecord("training-examples.json", updated);
  return updated;
}

async function tryAutoSync(expense, config) {
  if (!isGoogleSheetsConfigured(config)) {
    return {
      ...expense,
      syncStatus: "skipped",
      syncError: "Google Sheets is not configured."
    };
  }

  try {
    const syncResult = await syncExpenseToSheet(expense, config);
    return {
      ...expense,
      ...syncResult,
      updatedAt: nowIso()
    };
  } catch (error) {
    return {
      ...expense,
      syncStatus: "error",
      syncError: error.message,
      updatedAt: nowIso()
    };
  }
}

function createHttpError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireGoogleSheets(config) {
  const state = getGoogleSheetsConfigState(config);
  if (!state.configured) {
    throw createHttpError(state.reason || "Google Sheets is not configured.", 400);
  }
}

async function findExpenseById(id, config) {
  requireGoogleSheets(config);
  const expenses = await listExpensesFromSheet(config);
  return expenses.find((expense) => expense.id === id) ?? null;
}

async function resolveTrainingExampleImageUrl(example, config) {
  if (!example) {
    return null;
  }

  if (example.sourceStorage === "discord" && example.discordMessageId) {
    try {
      return await getDiscordAttachmentUrl({
        messageId: example.discordMessageId,
        attachmentId: example.discordAttachmentId,
        filename: example.discordFilename
      }, config);
    } catch {
      // Fall back to the last known direct URL when this device uses a different webhook.
    }
  }

  if (example.sourceImageDirectUrl) {
    return example.sourceImageDirectUrl;
  }

  if (example.sourceImage && !example.sourceImage.startsWith("/api/scans/")) {
    return example.sourceImage;
  }

  return null;
}

function buildMetaResponse(request) {
  const config = getRequestConfig(request);
  const googleSheetsState = getGoogleSheetsConfigState(config);
  const discordState = getDiscordUploadConfigState(config);

  return {
    categories: CATEGORIES,
    defaultCurrency: DEFAULT_CURRENCY,
    defaultLocale: DEFAULT_LOCALE,
    googleSheetsConfigured: googleSheetsState.configured,
    googleSheetsConfigReason: googleSheetsState.reason,
    discordUploadsConfigured: discordState.configured,
    discordUploadsConfigReason: discordState.reason,
    geminiConfigured: isGeminiConfigured(),
    settings: {
      googleSheetsSpreadsheetId: config.googleSheetsSpreadsheetId,
      discordWebhookUrl: config.discordWebhookUrl
    }
  };
}

app.get("/api/meta", (request, response) => {
  response.json(buildMetaResponse(request));
});

app.post("/api/scans", upload.single("receipt"), async (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Receipt image is required." });
      return;
    }

    const scanId = randomUUID();
    const requestConfig = getRequestConfig(request);
    const uploadResult = await saveUpload(request.file, requestConfig);
    const scanResult = await scanReceipt({
      file: request.file,
      base64Data: request.file.buffer.toString("base64"),
      mediaType: request.file.mimetype || "image/jpeg",
      locale: request.body.locale || DEFAULT_LOCALE
    });

    const timestamp = nowIso();
    const trainingExample = {
      id: scanId,
      locale: request.body.locale || DEFAULT_LOCALE,
      documentType: "retail-receipt",
      sourceImage: toScanImagePath(scanId),
      sourceImageDirectUrl: uploadResult.publicPath,
      sourceStorage: uploadResult.storage,
      discordMessageId: uploadResult.discordMessageId || null,
      discordAttachmentId: uploadResult.discordAttachmentId || null,
      discordFilename: uploadResult.discordFilename || null,
      extractedFields: normalizeScanDraft(scanResult.draft),
      reviewedFields: null,
      provider: scanResult.provider,
      rawModelOutput: scanResult.rawModelOutput,
      confidence: scanResult.confidence,
      issues: scanResult.issues,
      reviewStatus: "draft",
      expenseId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await upsertRecord("training-examples.json", trainingExample);

    response.json({
      scanId,
      sourceImage: toScanImagePath(scanId),
      draft: trainingExample.extractedFields,
      confidence: trainingExample.confidence,
      issues: trainingExample.issues,
      provider: trainingExample.provider
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/scans/:id/source-image", async (request, response) => {
  try {
    const example = await findRecord("training-examples.json", request.params.id);
    if (!example) {
      response.status(404).json({ error: "Source image not found." });
      return;
    }

    const sourceUrl = await resolveTrainingExampleImageUrl(example, getRequestConfig(request));
    if (!sourceUrl) {
      response.status(404).json({ error: "Source image is unavailable." });
      return;
    }

    response.set("cache-control", "no-store");
    response.redirect(sourceUrl);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/expenses", async (request, response) => {
  try {
    const config = getRequestConfig(request);
    requireGoogleSheets(config);
    const allExpenses = await listExpensesFromSheet(config);
    const search = String(request.query.search || "").trim().toLowerCase();
    const category = String(request.query.category || "all");
    const syncStatus = String(request.query.syncStatus || "all");
    const requestedPage = Math.max(Number(request.query.page) || 1, 1);
    const pageSize = Math.max(Number(request.query.pageSize) || PAGE_SIZE, 1);

    const filtered = allExpenses.filter((expense) => {
      const matchesSearch =
        !search ||
        expense.merchant.toLowerCase().includes(search) ||
        expense.notes.toLowerCase().includes(search);
      const matchesCategory = category === "all" || expense.category === category;
      const matchesSync = syncStatus === "all" || expense.syncStatus === syncStatus;
      return matchesSearch && matchesCategory && matchesSync;
    });

    const totalItems = filtered.length;
    const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
    const page = Math.min(requestedPage, totalPages);
    const startIndex = (page - 1) * pageSize;
    const items = filtered.slice(startIndex, startIndex + pageSize);

    response.json({
      items,
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages
      }
    });
  } catch (error) {
    response.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/api/expenses", async (request, response) => {
  try {
    const config = getRequestConfig(request);
    requireGoogleSheets(config);
    const expense = buildExpenseRecord(request.body, {
      sourceImage: request.body.sourceImage || "",
      scanId: request.body.scanId || null,
      scanStatus: request.body.scanId ? "scanned" : "manual",
      reviewStatus: "approved",
      syncStatus: "pending"
    });

    const saved = await tryAutoSync(expense, config);
    if (saved.syncStatus !== "synced") {
      response.status(500).json({ error: saved.syncError || "Failed to save expense to Google Sheets." });
      return;
    }

    await updateTrainingExample(saved.scanId, {
      reviewedFields: {
        merchant: saved.merchant,
        transactionDate: saved.transactionDate,
        currency: saved.currency,
        amountTotal: saved.amountTotal,
        category: saved.category,
        notes: saved.notes
      },
      reviewStatus: "approved",
      expenseId: saved.id,
      reviewedAt: saved.reviewedAt
    });

    response.status(201).json(saved);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.patch("/api/expenses/:id", async (request, response) => {
  try {
    const config = getRequestConfig(request);
    requireGoogleSheets(config);
    const current = await findExpenseById(request.params.id, config);
    if (!current) {
      response.status(404).json({ error: "Expense not found." });
      return;
    }

    const next = buildExpenseRecord(
      {
        merchant: request.body.merchant ?? current.merchant,
        transactionDate: request.body.transactionDate ?? current.transactionDate,
        currency: request.body.currency ?? current.currency,
        amountTotal: request.body.amountTotal ?? current.amountTotal,
        category: request.body.category ?? current.category,
        notes: request.body.notes ?? current.notes
      },
      {
        id: current.id,
        sourceImage: current.sourceImage,
        scanId: current.scanId,
        scanStatus: current.scanStatus,
        reviewStatus: "approved",
        syncStatus: current.sheetRowNumber ? "pending" : current.syncStatus,
        sheetRowNumber: current.sheetRowNumber,
        syncError: "",
        createdAt: current.createdAt,
        reviewedAt: nowIso()
      }
    );

    const synced = await tryAutoSync(next, config);
    if (synced.syncStatus !== "synced") {
      response.status(500).json({ error: synced.syncError || "Failed to update expense in Google Sheets." });
      return;
    }
    Object.assign(next, synced);

    await updateTrainingExample(next.scanId, {
      reviewedFields: {
        merchant: next.merchant,
        transactionDate: next.transactionDate,
        currency: next.currency,
        amountTotal: next.amountTotal,
        category: next.category,
        notes: next.notes
      },
      reviewStatus: "approved",
      expenseId: next.id,
      reviewedAt: next.reviewedAt
    });

    response.json(next);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.delete("/api/expenses/:id", async (request, response) => {
  try {
    const config = getRequestConfig(request);
    requireGoogleSheets(config);
    const current = await findExpenseById(request.params.id, config);
    if (!current) {
      response.status(404).json({ error: "Expense not found." });
      return;
    }

    await deleteExpenseFromSheet(current.sheetRowNumber, config);

    await updateTrainingExample(current.scanId, {
      reviewedFields: null,
      reviewStatus: "draft",
      expenseId: null,
      reviewedAt: null
    });

    response.json({ ok: true, id: current.id });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/expenses/:id/sync", async (request, response) => {
  try {
    const config = getRequestConfig(request);
    requireGoogleSheets(config);
    const current = await findExpenseById(request.params.id, config);
    if (!current) {
      response.status(404).json({ error: "Expense not found." });
      return;
    }

    const synced = await tryAutoSync(current, config);
    response.json(synced);
  } catch (error) {
    response.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get("/api/training-examples", async (_request, response) => {
  const items = await listRecords("training-examples.json");
  response.json({ items });
});

app.get(/.*/, (_request, response) => {
  response.sendFile(path.resolve(rootDir, "public", "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Bill Tracker running at http://localhost:${port}`);
});
