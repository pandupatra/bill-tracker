# Bill Tracker

Bill Tracker is a small receipt review and expense logging app for Indonesian retail receipts. It combines a Node.js/Express backend with a vanilla JavaScript frontend, supports AI-assisted receipt extraction, stores approved expenses locally in JSON files, and can sync approved rows to Google Sheets.

The app is built around a review-first workflow:

1. Upload a receipt image.
2. Run a scan to extract draft fields.
3. Review and correct the draft.
4. Save an approved expense.
5. Optionally sync the approved record to Google Sheets.

## What the app does

- Scans receipt images through Gemini when configured.
- Falls back to a mock extractor when Gemini is not configured, so the review flow still works.
- Supports manual expense entry without scanning.
- Persists approved expenses in `data/expenses.json`.
- Persists scan drafts and reviewed corrections in `data/training-examples.json`.
- Stores uploaded receipt images either locally or in Discord, depending on configuration.
- Re-syncs existing expenses to Google Sheets on demand.
- Supports searching, filtering, and paginating approved expenses from the UI.

## Main workflows

### 1. Scan and review a receipt

- Upload an image from the UI.
- The backend creates a scan record and stores the uploaded image.
- Gemini returns a normalized draft with:
  - `merchant`
  - `transactionDate`
  - `currency`
  - `amountTotal`
  - `category`
  - `notes`
  - `confidence`
  - `issues`
- The draft is shown in the form for human review before saving.

### 2. Save an approved expense

- When the form is submitted, the app validates and normalizes the values.
- The approved expense is written to `data/expenses.json`.
- If the expense originated from a scan, the related training example is updated with `reviewedFields` and linked back to the approved expense.
- If auto-sync is enabled, the app immediately attempts Google Sheets sync.

### 3. Edit and re-sync an expense

- Existing expenses can be edited from the ledger table.
- If an expense already has a Google Sheets row number, editing sets it back to `pending`.
- Users can manually re-run sync from the ledger.

### 4. Store receipt images

- If `DISCORD_WEBHOOK_URL` is configured, uploads are sent to Discord.
- Otherwise uploads are stored locally in `data/uploads/`.
- The app serves a stable internal image path for scans through `/api/scans/:id/source-image` so the frontend does not depend on raw Discord CDN URLs.

## Tech stack

- Node.js
- Express 5
- Multer for file upload handling
- Google Gemini API for receipt extraction
- Discord webhooks for optional image storage
- Google Sheets API for optional spreadsheet sync
- Vanilla HTML, CSS, and JavaScript frontend
- JSON files for persistence

## Project structure

```text
bill-tracker/
|-- data/
|   |-- expenses.json
|   |-- training-examples.json
|   `-- uploads/
|-- public/
|   |-- index.html
|   |-- styles.css
|   `-- js/
|       |-- api.js
|       |-- app.js
|       |-- state.js
|       `-- ui.js
|-- src/
|   |-- lib/
|   |   |-- loadEnv.js
|   |   |-- store.js
|   |   `-- validation.js
|   |-- services/
|   |   |-- discordUploads.js
|   |   |-- gemini.js
|   |   `-- googleSheets.js
|   |-- constants.js
|   `-- server.js
|-- .env.example
|-- package.json
`-- README.md
```

## Requirements

- Node.js 18 or later
- npm

Optional integrations:

- Gemini API key for real receipt extraction
- Discord webhook for remote receipt image storage
- Google service account + spreadsheet for sync

## Installation

```bash
npm install
```

## Running the app

Development mode:

```bash
npm run dev
```

Production-style run:

```bash
npm start
```

Syntax check for the server entry file:

```bash
npm run check
```

Default URL:

```text
http://localhost:3000
```

The port can be changed with `PORT`.

## Environment variables

Copy `.env.example` to `.env` and fill in the values you need.

### Core

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | HTTP server port. Defaults to `3000`. |

### Gemini

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | No | Enables real receipt extraction. If omitted, the app uses a mock extractor. |
| `GEMINI_MODEL` | No | Gemini model name. Defaults to `gemini-2.5-flash`. |

### Discord uploads

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | No | Enables Discord-based receipt image storage. |
| `DISCORD_WEBHOOK_THREAD_ID` | No | Optional thread ID appended to the webhook request. |

### Google Sheets

| Variable | Required | Description |
| --- | --- | --- |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | No | Target spreadsheet ID. |
| `GOOGLE_SHEETS_SHEET_NAME` | No | Sheet tab name. Defaults to `Expenses`. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | No | Service account email used for JWT auth. |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | No | Full PEM private key content. Must include `BEGIN PRIVATE KEY`. Use escaped newlines in `.env`. |

Example:

```env
PORT=3000

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

# Discord uploads
DISCORD_WEBHOOK_URL=
DISCORD_WEBHOOK_THREAD_ID=

# Google Sheets
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SHEETS_SHEET_NAME=Expenses
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## Integration behavior

### Gemini not configured

- Scan requests still work.
- The backend returns mock data inferred from the filename plus safe defaults.
- Provider is reported as `mock`.
- Confidence is low and issues explain that Gemini is not configured.

### Discord not configured

- Uploaded images are stored in `data/uploads/`.
- They are served as static files through `/uploads/...`.

### Google Sheets not configured

- Expenses are still saved locally.
- Sync status becomes `skipped`.
- Sync error explains that Google Sheets is not configured.

## Validation and normalization rules

All approved expenses and scan drafts are normalized before storage:

- Unknown or empty merchant becomes `Unknown`.
- Invalid or missing dates fall back to today's date.
- Amounts are converted to numbers by stripping non-numeric characters.
- Invalid categories fall back to `Other`.
- Empty currency falls back to `IDR`.
- Notes are trimmed and limited to 200 characters.

## Default categories and locale

Categories:

- `Food`
- `Transport`
- `Shopping`
- `Utilities`
- `Health`
- `Entertainment`
- `Household`
- `Bills`
- `Other`

Defaults:

- Currency: `IDR`
- Locale hint sent to scan service: `id-ID`
- Ledger page size: `10`

## Data storage

This app does not use a database. It stores records in JSON files under `data/`.

### `data/expenses.json`

Approved expense records. Example shape:

```json
{
  "id": "uuid",
  "merchant": "Indomaret",
  "transactionDate": "2026-03-10",
  "currency": "IDR",
  "amountTotal": 76300,
  "category": "Shopping",
  "notes": "Purchase of groceries.",
  "sourceImage": "/api/scans/<scanId>/source-image",
  "scanId": "uuid-or-null",
  "scanStatus": "scanned | manual | reviewed",
  "reviewStatus": "approved",
  "syncStatus": "pending | synced | error | skipped",
  "sheetRowNumber": 1,
  "syncError": "",
  "reviewedAt": "ISO timestamp",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

### `data/training-examples.json`

Scan and review history used as correction/training examples. Example shape:

```json
{
  "id": "scan-id",
  "locale": "id-ID",
  "documentType": "retail-receipt",
  "sourceImage": "/api/scans/<scanId>/source-image",
  "sourceImageDirectUrl": "/uploads/<file>",
  "sourceStorage": "local | discord",
  "discordMessageId": null,
  "discordAttachmentId": null,
  "discordFilename": null,
  "extractedFields": {
    "merchant": "string",
    "transactionDate": "YYYY-MM-DD",
    "currency": "IDR",
    "amountTotal": 0,
    "category": "Other",
    "notes": "string"
  },
  "reviewedFields": null,
  "provider": "gemini | mock",
  "rawModelOutput": "raw response text",
  "confidence": 0.95,
  "issues": [],
  "reviewStatus": "draft | approved",
  "expenseId": null,
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

## Google Sheets sync format

When an expense is synced, the app writes columns `A:K` in this order:

| Column | Value |
| --- | --- |
| A | `id` |
| B | `merchant` |
| C | `transactionDate` |
| D | `amountTotal` |
| E | `currency` |
| F | `category` |
| G | `notes` |
| H | `sourceImage` |
| I | `reviewedAt` |
| J | `syncStatus` |
| K | `syncError` |

Behavior:

- New expenses are appended.
- Existing synced expenses with `sheetRowNumber` are updated in place.
- Successful sync sets `syncStatus` to `synced`.
- Failed sync sets `syncStatus` to `error` and stores the error message.

## Frontend behavior

The UI is a single-page interface served from `public/`.

It includes:

- A hero area showing integration status.
- Metrics for total spend, current month spend, approved bill count, and pending sync count.
- A receipt upload and scan section.
- A review form for scanned or manual entries.
- A ledger table with:
  - search
  - category filter
  - sync-status filter
  - pagination
  - edit action
  - manual sync action

## API reference

### `GET /api/meta`

Returns runtime metadata used by the UI.

Response:

```json
{
  "categories": ["Food", "Transport", "Shopping"],
  "defaultCurrency": "IDR",
  "defaultLocale": "id-ID",
  "googleSheetsConfigured": true,
  "googleSheetsConfigReason": "",
  "geminiConfigured": true
}
```

### `POST /api/scans`

Uploads a receipt image and creates a scan draft.

Request:

- Content type: `multipart/form-data`
- Field: `receipt`
- Optional field: `locale`

Response:

```json
{
  "scanId": "uuid",
  "sourceImage": "/api/scans/uuid/source-image",
  "draft": {
    "merchant": "string",
    "transactionDate": "YYYY-MM-DD",
    "currency": "IDR",
    "amountTotal": 0,
    "category": "Other",
    "notes": "string"
  },
  "confidence": 0.95,
  "issues": [],
  "provider": "gemini"
}
```

Notes:

- File size limit is 8 MB.
- If no file is provided, the route returns `400`.

### `GET /api/scans/:id/source-image`

Redirects to the stored source image for a scan.

Behavior:

- Resolves Discord attachment URLs when Discord storage is used.
- Redirects to a local `/uploads/...` path when local storage is used.
- Returns `404` if the scan or image is unavailable.

### `GET /api/expenses`

Lists approved expenses with filtering and pagination.

Query parameters:

| Parameter | Description |
| --- | --- |
| `search` | Matches `merchant` or `notes`. |
| `category` | Category filter or `all`. |
| `syncStatus` | Sync filter or `all`. |
| `page` | 1-based page number. |
| `pageSize` | Number of records per page. |

Response:

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "totalItems": 0,
    "totalPages": 1
  }
}
```

### `POST /api/expenses`

Creates an approved expense.

Request body:

```json
{
  "merchant": "string",
  "transactionDate": "YYYY-MM-DD",
  "currency": "IDR",
  "amountTotal": 10000,
  "category": "Food",
  "notes": "string",
  "scanId": "uuid-or-null",
  "sourceImage": "/api/scans/uuid/source-image",
  "autoSync": true
}
```

Behavior:

- Creates a normalized expense record.
- Attempts Google Sheets sync unless `autoSync` is explicitly `false`.
- Updates the linked training example if `scanId` is present.

Returns `201` on success.

### `PATCH /api/expenses/:id`

Updates an existing approved expense.

Behavior:

- Preserves IDs and historical metadata.
- Clears previous sync errors.
- Sets `reviewedAt` to the current time.
- If the record has already been synced before, its sync status becomes `pending` so it can be re-synced.

### `POST /api/expenses/:id/sync`

Runs sync again for an existing expense.

Behavior:

- Appends a new row if the expense has never been synced.
- Updates the known row if `sheetRowNumber` already exists.

### `GET /api/training-examples`

Returns all stored training examples.

Response:

```json
{
  "items": []
}
```

## Error handling

The server returns JSON errors in this format:

```json
{
  "error": "Message"
}
```

Typical failure cases:

- Missing upload file
- Gemini API failure
- Invalid Discord webhook URL
- Missing or malformed Google Sheets credentials
- Missing expense or scan record

## Operational notes

- The server loads `.env` manually through `src/lib/loadEnv.js`; no external dotenv package is used.
- The app serves both API routes and frontend assets from the same Express server.
- Uploaded images are kept in memory during request processing via Multer memory storage.
- `data/` files are created automatically if missing.
- Records are written back as full JSON arrays, which is acceptable for small datasets but not intended for high concurrency or large-scale workloads.

## Limitations

- No authentication or authorization.
- No database; concurrent writes can become a problem at larger scale.
- No delete flow for expenses, scans, or uploads.
- No itemized receipt extraction; only summary-level fields are stored.
- Frontend is optimized around Indonesian receipts and `IDR`.
- No automated tests are included in the repository.

## Development notes

Relevant source files:

- Backend entry: `src/server.js`
- Scan service: `src/services/gemini.js`
- Discord upload service: `src/services/discordUploads.js`
- Google Sheets sync: `src/services/googleSheets.js`
- JSON store helpers: `src/lib/store.js`
- Input normalization: `src/lib/validation.js`
- Frontend controller: `public/js/app.js`

## Quick start checklist

1. Install dependencies with `npm install`.
2. Create `.env` from `.env.example`.
3. Add `GEMINI_API_KEY` if you want real receipt extraction.
4. Add Google Sheets credentials if you want automatic sync.
5. Optionally add a Discord webhook if you want remote image storage.
6. Start the app with `npm run dev`.
7. Open `http://localhost:3000`.

## License

No license file is currently included in this repository.
