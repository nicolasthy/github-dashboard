import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { markOutcome, recordDelivery } from "./dedup";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE delivery_log (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      action TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('applied','dedup','stale','rejected','ignored'))
    )
  `);
  return db;
}

let db: Database;

beforeEach(() => {
  db = makeTestDb();
});

test("first call with a delivery_id returns 'new'", () => {
  const result = recordDelivery(db, "delivery-001", "pull_request", "opened");
  expect(result).toBe("new");
});

test("second call with the same id returns 'dup'", () => {
  recordDelivery(db, "delivery-001", "pull_request", "opened");
  const result = recordDelivery(db, "delivery-001", "pull_request", "opened");
  expect(result).toBe("dup");
});

test("different delivery_ids are independent", () => {
  const r1 = recordDelivery(db, "delivery-001", "pull_request", "opened");
  const r2 = recordDelivery(db, "delivery-002", "pull_request", "closed");
  expect(r1).toBe("new");
  expect(r2).toBe("new");
});

test("markOutcome updates processed_at and outcome", () => {
  recordDelivery(db, "delivery-001", "pull_request", "opened");
  markOutcome(db, "delivery-001", "stale");
  const row = db
    .query("SELECT outcome, processed_at FROM delivery_log WHERE delivery_id = ?")
    .get("delivery-001") as { outcome: string; processed_at: string | null };
  expect(row.outcome).toBe("stale");
  expect(row.processed_at).not.toBeNull();
});

test("recordDelivery does not store payload body", () => {
  recordDelivery(db, "delivery-001", "pull_request", "opened");
  const row = db
    .query("SELECT * FROM delivery_log WHERE delivery_id = ?")
    .get("delivery-001") as Record<string, unknown>;
  // Only these columns should exist
  const keys = Object.keys(row);
  expect(keys).not.toContain("body");
  expect(keys).not.toContain("payload");
});
