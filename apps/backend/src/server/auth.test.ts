import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { issueToken } from "../auth/token-store.ts";
import { requireBearer } from "./auth.ts";

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE api_token (
      token_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
  return db;
}

function makeRequest(authHeader?: string): Request {
  return new Request("http://localhost/api/prs", {
    headers: authHeader ? { Authorization: authHeader } : {},
  });
}

let db: Database;

beforeEach(() => {
  db = makeTestDb();
});

test("missing Authorization header returns 401", async () => {
  const middleware = requireBearer(db);
  const result = await middleware(makeRequest());
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
});

test("wrong token returns 401", async () => {
  const middleware = requireBearer(db);
  const result = await middleware(makeRequest("Bearer gpt_wrongtoken"));
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
});

test("valid token returns ApiToken", async () => {
  const { token_plaintext } = await issueToken(db, "test");
  const middleware = requireBearer(db);
  const result = await middleware(makeRequest(`Bearer ${token_plaintext}`));
  // Should NOT be a Response — should be an ApiToken object
  expect(result).not.toBeInstanceOf(Response);
  const token = result as { label: string };
  expect(token.label).toBe("test");
});

test("non-Bearer scheme returns 401", async () => {
  const middleware = requireBearer(db);
  const result = await middleware(makeRequest("Basic dXNlcjpwYXNz"));
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
});
