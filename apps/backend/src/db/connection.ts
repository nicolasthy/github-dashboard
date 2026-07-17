export type { Database } from "bun:sqlite";

import { Database } from "bun:sqlite";
import { join } from "node:path";

class InvalidKeyFormatError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "InvalidKeyFormatError";
  }
}

class WrongKeyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "WrongKeyError";
  }
}

export { InvalidKeyFormatError, WrongKeyError };

function resolveDbPath(): string {
  const envPath = process.env["PR_TRACKER_DB"];
  if (envPath) return envPath;
  // Default: apps/backend/data/prs.db relative to monorepo root
  return join(import.meta.dir, "..", "..", "data", "prs.db");
}

export function open(): Database {
  const path = resolveDbPath();
  const db = new Database(path, { create: true });
  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Verify DB is readable
  const result = db.query("SELECT 1 AS v").get() as { v: number } | null;
  if (!result || result.v !== 1) {
    throw new WrongKeyError("DB self-check failed: SELECT 1 returned unexpected result");
  }
  return db;
}

export function close(db: Database): void {
  db.close();
}

export function selfTest(): void {
  const db = open();
  try {
    const result = db.query("SELECT 1 AS v").get() as { v: number } | null;
    if (!result || result.v !== 1) {
      throw new WrongKeyError("selfTest failed: SELECT 1 returned unexpected result");
    }
  } finally {
    close(db);
  }
}
