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
  getDiscordAttachmentUrl,
  isDiscordUploadConfigured,
  uploadReceiptToDiscord
} from "./services/discordUploads.js";
import { isGeminiConfigured, scanReceipt } from "./services/gemini.js";
import {
  getGoogleSheetsConfigState,
  isGoogleSheetsConfigured,
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

async function saveUpload(file) {
  if (isDiscordUploadConfigured()) {
    return uploadReceiptToDiscord(file);
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

async function tryAutoSync(expense) {
  if (!isGoogleSheetsConfigured()) {
    return {
      ...expense,
      syncStatus: "skipped",
      syncError: "Google Sheets is not configured."
    };
  }

  try {
    const syncResult = await syncExpenseToSheet(expense);
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

async function resolveTrainingExampleImageUrl(example) {
  if (!example) {
    return null;
  }

  if (example.sourceStorage === "discord" && example.discordMessageId) {
    return getDiscordAttachmentUrl({
      messageId: example.discordMessageId,
      attachmentId: example.discordAttachmentId,
      filename: example.discordFilename
    });
  }

  if (example.sourceImageDirectUrl) {
    return example.sourceImageDirectUrl;
  }

  if (example.sourceImage && !example.sourceImage.startsWith("/api/scans/")) {
    return example.sourceImage;
  }

  return null;
}

app.get("/api/meta", (_request, response) => {
  const googleSheetsState = getGoogleSheetsConfigState();

  response.json({
    categories: CATEGORIES,
    defaultCurrency: DEFAULT_CURRENCY,
    defaultLocale: DEFAULT_LOCALE,
    googleSheetsConfigured: googleSheetsState.configured,
    googleSheetsConfigReason: googleSheetsState.reason,
    geminiConfigured: isGeminiConfigured()
  });
});

app.post("/api/scans", upload.single("receipt"), async (request, response) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: "Receipt image is required." });
      return;
    }

    const scanId = randomUUID();
    const uploadResult = await saveUpload(request.file);
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

    const sourceUrl = await resolveTrainingExampleImageUrl(example);
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
  const allExpenses = await listRecords("expenses.json");
  const search = String(request.query.search || "").trim().toLowerCase();
  const category = String(request.query.category || "all");
  const syncStatus = String(request.query.syncStatus || "all");
  const page = Math.max(Number(request.query.page) || 1, 1);
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
  const startIndex = (page - 1) * pageSize;
  const items = filtered.slice(startIndex, startIndex + pageSize);

  response.json({
    items,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages: Math.max(Math.ceil(totalItems / pageSize), 1)
    }
  });
});

app.post("/api/expenses", async (request, response) => {
  try {
    const expense = buildExpenseRecord(request.body, {
      sourceImage: request.body.sourceImage || "",
      scanId: request.body.scanId || null,
      scanStatus: request.body.scanId ? "scanned" : "manual",
      reviewStatus: "approved",
      syncStatus: "pending"
    });

    const saved = request.body.autoSync === false ? expense : await tryAutoSync(expense);
    await upsertRecord("expenses.json", saved);

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
    const current = await findRecord("expenses.json", request.params.id);
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

    await upsertRecord("expenses.json", next);
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

app.post("/api/expenses/:id/sync", async (request, response) => {
  try {
    const current = await findRecord("expenses.json", request.params.id);
    if (!current) {
      response.status(404).json({ error: "Expense not found." });
      return;
    }

    const synced = await tryAutoSync(current);
    await upsertRecord("expenses.json", synced);
    response.json(synced);
  } catch (error) {
    response.status(500).json({ error: error.message });
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
