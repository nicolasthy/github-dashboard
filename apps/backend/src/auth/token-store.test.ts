import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { issueToken, listTokens, revokeToken, verifyToken } from "./token-store";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE api_token (
      token_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
});

afterEach(() => {
  db.close();
});

test("issued plaintext verifies via verifyToken", async () => {
  const { token_plaintext } = await issueToken(db, "test-label");
  const found = await verifyToken(db, token_plaintext);
  expect(found).not.toBeNull();
  expect(found?.label).toBe("test-label");
});

test("wrong plaintext returns null", async () => {
  await issueToken(db, "test-label");
  const found = await verifyToken(db, "gpt_wrongtoken");
  expect(found).toBeNull();
});

test("revoked token returns null on verify", async () => {
  const { token_id, token_plaintext } = await issueToken(db, "test-label");
  revokeToken(db, token_id);
  const found = await verifyToken(db, token_plaintext);
  expect(found).toBeNull();
});

test("stored hash contains argon2id params", async () => {
  await issueToken(db, "param-check");
  const row = db.query("SELECT hash FROM api_token").get() as { hash: string };
  // Expected: $argon2id$v=19$m=19456,t=2,p=1$...
  expect(row.hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
});

test("listTokens returns tokens without hash field", async () => {
  await issueToken(db, "first");
  await issueToken(db, "second");
  const tokens = listTokens(db);
  expect(tokens.length).toBe(2);
  for (const t of tokens) {
    expect(t).not.toHaveProperty("hash");
    expect(t).toHaveProperty("token_id");
    expect(t).toHaveProperty("label");
    expect(t).toHaveProperty("created_at");
    expect(t).toHaveProperty("last_used_at");
  }
});
