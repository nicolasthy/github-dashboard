import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { startWebhookServer } from "./webhook.ts";

const TEST_SECRET = "test-secret-1234";
const TEST_PORT = 18787;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function makeTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository (
      repo_id INTEGER PRIMARY KEY,
      owner_login TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
      added_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person (
      user_id INTEGER PRIMARY KEY,
      login TEXT NOT NULL,
      avatar_url TEXT,
      first_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_request (
      github_pr_id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      repo_id INTEGER NOT NULL REFERENCES repository(repo_id),
      author_user_id INTEGER NOT NULL REFERENCES person(user_id),
      state TEXT NOT NULL CHECK(state IN ('open','closed')),
      draft INTEGER NOT NULL CHECK(draft IN (0,1)),
      title TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      merged_at TEXT,
      html_url TEXT NOT NULL,
      last_event_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review (
      review_id INTEGER PRIMARY KEY,
      pr_id INTEGER NOT NULL REFERENCES pull_request(github_pr_id) ON DELETE CASCADE,
      reviewer_user_id INTEGER NOT NULL REFERENCES person(user_id),
      state TEXT NOT NULL CHECK(state IN ('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED')),
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_log (
      delivery_id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      action TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      outcome TEXT NOT NULL CHECK(outcome IN ('applied','dedup','stale','rejected','ignored'))
    );
    CREATE TABLE IF NOT EXISTS repo_state (
      repo_id INTEGER PRIMARY KEY REFERENCES repository(repo_id) ON DELETE CASCADE,
      last_reconciled_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_token (
      token_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  return db;
}

function sign(body: string | Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(typeof body === "string" ? Buffer.from(body) : body);
  return `sha256=${hmac.digest("hex")}`;
}

let server: ReturnType<typeof Bun.serve>;
let db: Database;

beforeEach(() => {
  // MUST set env var before startWebhookServer — secret is captured in closure at start time
  process.env["GITHUB_WEBHOOK_SECRET"] = TEST_SECRET;
  db = makeTestDb();
  server = startWebhookServer({
    db,
    port: TEST_PORT,
    hostname: "127.0.0.1",
  });
});

afterEach(async () => {
  await server.stop(true);
  db.close();
  delete process.env["GITHUB_WEBHOOK_SECRET"];
});

describe("GET /ping", () => {
  test("returns 200 with body 'pong'", async () => {
    const res = await fetch(`${BASE_URL}/ping`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });
});

describe("unknown routes", () => {
  test("GET / returns 404", async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(404);
  });

  test("GET /unknown returns 404", async () => {
    const res = await fetch(`${BASE_URL}/unknown`);
    expect(res.status).toBe(404);
  });

  test("POST /other returns 404", async () => {
    const body = "{}";
    const res = await fetch(`${BASE_URL}/other`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body, TEST_SECRET),
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-404",
      },
      body,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /webhook — signature check", () => {
  test("missing signature returns 401", async () => {
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-no-sig",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("unauthorized");
  });

  test("wrong signature returns 401", async () => {
    const body = "{}";
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body, "wrong-secret"),
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-bad-sig",
      },
      body,
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /webhook — valid request", () => {
  test("valid signed ping returns 200 with outcome applied", async () => {
    const body = JSON.stringify({ action: null });
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body, TEST_SECRET),
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-valid-001",
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; outcome: string };
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("applied");
  });

  test("unknown event returns 200 with outcome ignored", async () => {
    const body = JSON.stringify({ action: "something" });
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(body, TEST_SECRET),
        "X-GitHub-Event": "merge_queue_entry",
        "X-GitHub-Delivery": "delivery-ignored-001",
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; outcome: string };
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("ignored");
  });
});

describe("POST /webhook — body size limit", () => {
  test("body > 25 MiB returns 413", async () => {
    // Send an actual large body — Bun sets correct content-length automatically,
    // triggering the server-side size guard before HMAC verification.
    const largeBody = Buffer.alloc(26 * 1024 * 1024, 65); // 26 MiB of 'A'
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-toolarge",
        // No signature needed — rejected before HMAC check
      },
      body: largeBody,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe("payload too large");
  });
});

describe("POST /webhook — dedup", () => {
  test("duplicate delivery_id returns 200 with outcome dedup", async () => {
    const body = JSON.stringify({ action: null });
    const headers = {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sign(body, TEST_SECRET),
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": "delivery-dedup-001",
    };

    // First delivery — should be applied
    const res1 = await fetch(`${BASE_URL}/webhook`, { method: "POST", headers, body });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as { ok: boolean; outcome: string };
    expect(json1.outcome).toBe("applied");

    // Second delivery with same ID — should be dedup
    const res2 = await fetch(`${BASE_URL}/webhook`, { method: "POST", headers, body });
    expect(res2.status).toBe(200);
    const json2 = (await res2.json()) as { ok: boolean; outcome: string };
    expect(json2.ok).toBe(true);
    expect(json2.outcome).toBe("dedup");
  });
});
