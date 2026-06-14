import { expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { open, close, selfTest } from "./connection.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/test-connection-" + Date.now() + ".db";

afterEach(() => {
  if (existsSync(TEST_DB)) {
    unlinkSync(TEST_DB);
  }
});

test("open() returns a working Database", () => {
  process.env["PR_TRACKER_DB"] = TEST_DB;
  const db = open();
  expect(db).toBeInstanceOf(Database);
  close(db);
  delete process.env["PR_TRACKER_DB"];
});

test("open() enables WAL mode", () => {
  process.env["PR_TRACKER_DB"] = TEST_DB;
  const db = open();
  const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(result.journal_mode).toBe("wal");
  close(db);
  delete process.env["PR_TRACKER_DB"];
});

test("open() enables foreign keys", () => {
  process.env["PR_TRACKER_DB"] = TEST_DB;
  const db = open();
  const result = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
  expect(result.foreign_keys).toBe(1);
  close(db);
  delete process.env["PR_TRACKER_DB"];
});

test("selfTest() passes on valid DB", () => {
  process.env["PR_TRACKER_DB"] = TEST_DB;
  expect(() => selfTest()).not.toThrow();
  delete process.env["PR_TRACKER_DB"];
});
