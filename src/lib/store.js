import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve("data");

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function ensureFile(filePath) {
  await ensureDir();
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await writeFile(filePath, "[]", "utf8");
  }
}

async function readCollection(filename) {
  const filePath = path.join(DATA_DIR, filename);
  await ensureFile(filePath);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw || "[]");
}

async function writeCollection(filename, records) {
  const filePath = path.join(DATA_DIR, filename);
  await ensureFile(filePath);
  await writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
}

export async function listRecords(filename) {
  return readCollection(filename);
}

export async function saveRecords(filename, records) {
  await writeCollection(filename, records);
}

export async function upsertRecord(filename, record) {
  const records = await readCollection(filename);
  const index = records.findIndex((item) => item.id === record.id);
  if (index === -1) {
    records.unshift(record);
  } else {
    records[index] = record;
  }
  await writeCollection(filename, records);
  return record;
}

export async function findRecord(filename, id) {
  const records = await readCollection(filename);
  return records.find((item) => item.id === id) ?? null;
}
