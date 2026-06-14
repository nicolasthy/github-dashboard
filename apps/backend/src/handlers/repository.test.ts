import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import type { RepositoryRenamedEvent } from "@repo/types";

import { handleRepository } from "./repository";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE repository (
      repo_id INTEGER PRIMARY KEY,
      owner_login TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
      added_at TEXT NOT NULL
    )
  `);
  return db;
}

function makePayload(repoId: number, newName: string, ownerLogin: string): RepositoryRenamedEvent {
  return {
    action: "renamed",
    repository: {
      id: repoId,
      name: newName,
      owner: {
        avatar_url: "https://example.com/avatar",
        id: 1,
        login: ownerLogin,
      },
    },
  };
}

let db: Database;

beforeEach(() => {
  db = makeTestDb();
  // Seed a tracked repo
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(12345, "my-org", "old-name", 1, new Date().toISOString());
});

test("rename updates name for tracked repo", () => {
  const payload = makePayload(12345, "new-name", "my-org");
  const result = handleRepository(db, payload);
  expect(result).toBe("applied");
  const row = db.query("SELECT name FROM repository WHERE repo_id = 12345").get() as {
    name: string;
  };
  expect(row.name).toBe("new-name");
});

test("rename for untracked repo returns 'ignored'", () => {
  const payload = makePayload(99999, "new-name", "my-org");
  const result = handleRepository(db, payload);
  expect(result).toBe("ignored");
});

test("non-renamed action returns 'ignored'", () => {
  const payload = {
    action: "created" as "renamed",
    repository: {
      id: 12345,
      name: "test",
      owner: { id: 1, login: "my-org", avatar_url: "" },
    },
  };
  const result = handleRepository(db, payload);
  expect(result).toBe("ignored");
});

test("rename does not throw error", () => {
  const payload = makePayload(12345, "new-name", "my-org");
  expect(() => handleRepository(db, payload)).not.toThrow();
});
