import path from "node:path";
import { DEFAULT_CURRENCY } from "../constants.js";
import { normalizeScanDraft } from "../lib/validation.js";

function getGeminiUrl() {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export function isGeminiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

function buildPrompt(locale) {
  return [
    "Analyze this retail receipt image and respond with valid JSON only.",
    "Target locale: Indonesian retail receipts unless the document clearly indicates otherwise.",
    "Extract a summary only, not itemized products.",
    "Return this JSON shape exactly:",
    "{",
    '  "merchant": "string",',
    '  "transactionDate": "YYYY-MM-DD",',
    '  "currency": "IDR",',
    '  "amountTotal": 0,',
    '  "category": "Food | Transport | Shopping | Utilities | Health | Entertainment | Household | Bills | Other",',
    '  "notes": "short summary up to 120 chars",',
    '  "confidence": 0.0,',
    '  "issues": ["array of short uncertainty notes"]',
    "}",
    "If a field is missing, use safe defaults rather than inventing detailed facts.",
    `Locale hint: ${locale}.`
  ].join("\n");
}

function parseJsonPayload(rawText) {
  const clean = rawText.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

function inferMerchantFromFilename(filename) {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[_-]+/g, " ")
    .replace(/\b(receipt|bill|invoice|scan)\b/gi, "")
    .trim() || "Unknown";
}

function mockScan(file) {
  const merchant = inferMerchantFromFilename(file.originalname);
  const draft = normalizeScanDraft({
    merchant,
    transactionDate: new Date().toISOString().slice(0, 10),
    currency: DEFAULT_CURRENCY,
    amountTotal: 0,
    category: "Other",
    notes: "Mock extraction. Configure Gemini for real scan output."
  });

  return {
    provider: "mock",
    rawModelOutput: JSON.stringify({
      ...draft,
      confidence: 0.18,
      issues: ["Gemini API key is not configured."]
    }),
    draft,
    confidence: 0.18,
    issues: ["Gemini API key is not configured."]
  };
}

function extractResponseText(payload) {
  return (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("");
}

export async function scanReceipt({ file, base64Data, mediaType, locale }) {
  if (!isGeminiConfigured()) {
    return mockScan(file);
  }

  const response = await fetch(getGeminiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: buildPrompt(locale)
            },
            {
              inline_data: {
                mime_type: mediaType,
                data: base64Data
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini scan failed: ${response.status} ${errorBody}`);
  }

  const payload = await response.json();
  const rawText = extractResponseText(payload);
  const parsed = parseJsonPayload(rawText);
  const draft = normalizeScanDraft(parsed);

  return {
    provider: "gemini",
    rawModelOutput: rawText,
    draft,
    confidence: Number(parsed.confidence) || 0,
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : []
  };
}
