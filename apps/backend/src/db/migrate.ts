import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(): unknown[]; run(...args: unknown[]): unknown };
  transaction(fn: () => void): () => void;
}

export function runMigrations(db: SqlDb): void {
  // Ensure tracking table exists before querying it
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );

  type VersionRow = { version: string };
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as VersionRow[]).map(
      (r) => r.version,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.slice(0, -4); // strip .sql extension
    if (applied.has(version)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
    })();
  }
}

export async function main(): Promise<void> {
  const { default: Database } = await import("better-sqlite3-multiple-ciphers");

  const key = process.env["PR_TRACKER_KEY"] ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    process.stderr.write("PR_TRACKER_KEY must be exactly 64 hex characters\n");
    process.exit(1);
  }

  const dbPath = process.env["PR_TRACKER_DB"] ?? "data/tracker.db";
  const db = new Database(dbPath);
  db.pragma(`key = x'${key}'`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare("SELECT 1").get(); // verify key is accepted

  runMigrations(db as unknown as SqlDb);
  process.stdout.write("Migrations applied successfully\n");
  db.close();
}

if (import.meta.main) {
  await main().catch((e: unknown) => {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  });
}
