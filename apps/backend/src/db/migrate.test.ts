import { Database as BunDB } from "bun:sqlite";
import { expect, test } from "bun:test";
import { runMigrations } from "./migrate";

type SqlDb = Parameters<typeof runMigrations>[0];

function openTestDb(): { db: BunDB; sqlDb: SqlDb } {
  const db = new BunDB(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  const sqlDb: SqlDb = {
    exec: (sql: string) => {
      db.exec(sql);
    },
    prepare: (sql: string) => ({
      all: (): unknown[] => db.prepare(sql).all() as unknown[],
      run: (...args: unknown[]): void => {
        db.prepare(sql).run(...(args as unknown as string[]));
      },
    }),
    transaction: (fn: () => void): (() => void) => db.transaction(fn),
  };

  return { db, sqlDb };
}

test("fresh DB creates exactly 8 tables after migration", () => {
  const { db, sqlDb } = openTestDb();
  runMigrations(sqlDb);

  type TableRow = { name: string };
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as TableRow[];

  expect(tables).toHaveLength(8);

  const names = tables.map((r) => r.name);
  expect(names).toContain("repository");
  expect(names).toContain("person");
  expect(names).toContain("pull_request");
  expect(names).toContain("review");
  expect(names).toContain("delivery_log");
  expect(names).toContain("repo_state");
  expect(names).toContain("api_token");
  expect(names).toContain("schema_migrations");

  db.close();
});

test("re-running migrations is a no-op (idempotent)", () => {
  const { db, sqlDb } = openTestDb();
  runMigrations(sqlDb);
  runMigrations(sqlDb);

  type VersionRow = { version: string };
  const migrations = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as VersionRow[];

  expect(migrations).toHaveLength(1);
  expect(migrations[0]?.version).toBe("0001_init");

  db.close();
});

test("PRAGMA foreign_keys is ON after setup", () => {
  const { db, sqlDb } = openTestDb();
  runMigrations(sqlDb);

  type PragmaRow = { foreign_keys: number };
  const result = db.prepare("PRAGMA foreign_keys").get() as PragmaRow | null;
  expect(result?.foreign_keys).toBe(1);

  db.close();
});

test("CHECK constraint rejects invalid state in pull_request", () => {
  const { db, sqlDb } = openTestDb();
  runMigrations(sqlDb);

  db.run(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (1, 'org', 'repo', 1, '2026-01-01T00:00:00Z')",
  );
  db.run(
    "INSERT INTO person (user_id, login, first_seen_at) VALUES (1, 'user', '2026-01-01T00:00:00Z')",
  );

  expect(() => {
    db.run(
      `INSERT INTO pull_request
         (github_pr_id, node_id, number, repo_id, author_user_id, state, draft,
          title, head_sha, created_at, updated_at, html_url, last_event_at)
       VALUES
         (1, 'PR_1', 1, 1, 1, 'merged', 0, 'test', 'abc',
          '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'http://x', '2026-01-01T00:00:00Z')`,
    );
  }).toThrow();

  db.close();
});

test("all 5 indexes are present after migration", () => {
  const { db, sqlDb } = openTestDb();
  runMigrations(sqlDb);

  type IndexRow = { name: string };
  const allIndexes = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
        .all() as IndexRow[]
    ).map((r) => r.name),
  );

  expect(allIndexes.has("idx_pr_state_repo_updated")).toBe(true);
  expect(allIndexes.has("idx_pr_author")).toBe(true);
  expect(allIndexes.has("idx_review_pr")).toBe(true);
  expect(allIndexes.has("idx_delivery_received")).toBe(true);
  expect(allIndexes.has("idx_repo_active")).toBe(true);

  db.close();
});
