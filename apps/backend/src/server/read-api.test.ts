import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { issueToken } from "../auth/token-store.ts";
import { startReadApiServer } from "./read-api.ts";

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
    CREATE TABLE IF NOT EXISTS api_token (
      token_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
  `);
  return db;
}

function seedData(db: Database): void {
  // Active repo
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "octocat", "hello-world", 1, "2024-01-01T00:00:00Z");

  // Inactive (soft-disabled) repo
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(2, "octocat", "disabled-repo", 0, "2024-01-01T00:00:00Z");

  // People
  db.prepare(
    "INSERT INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, ?, ?, ?)",
  ).run(101, "alice", "https://example.com/alice.png", "2024-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, ?, ?, ?)",
  ).run(102, "bob", "https://example.com/bob.png", "2024-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, ?, ?, ?)",
  ).run(103, "charlie", "https://example.com/charlie.png", "2024-01-01T00:00:00Z");

  const insertPr = db.prepare(`
    INSERT INTO pull_request
      (github_pr_id, node_id, number, repo_id, author_user_id, state, draft,
       title, head_sha, created_at, updated_at, closed_at, merged_at, html_url, last_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // PR 1001: open, active repo, by alice
  insertPr.run(
    1001,
    "PR_kwDOABCD001",
    1,
    1,
    101,
    "open",
    0,
    "Open PR by alice",
    "abc123",
    "2024-01-01T00:00:00Z",
    "2024-01-10T00:00:00Z",
    null,
    null,
    "https://github.com/octocat/hello-world/pull/1",
    "2024-01-10T00:00:00Z",
  );

  // PR 1002: closed, active repo, by bob
  insertPr.run(
    1002,
    "PR_kwDOABCD002",
    2,
    1,
    102,
    "closed",
    0,
    "Closed PR by bob",
    "def456",
    "2024-01-02T00:00:00Z",
    "2024-01-09T00:00:00Z",
    "2024-01-09T00:00:00Z",
    null,
    "https://github.com/octocat/hello-world/pull/2",
    "2024-01-09T00:00:00Z",
  );

  // PR 1003: open, soft-disabled repo, by alice
  insertPr.run(
    1003,
    "PR_kwDOABCD003",
    1,
    2,
    101,
    "open",
    0,
    "PR in disabled repo",
    "ghi789",
    "2024-01-03T00:00:00Z",
    "2024-01-08T00:00:00Z",
    null,
    null,
    "https://github.com/octocat/disabled-repo/pull/1",
    "2024-01-08T00:00:00Z",
  );

  // Review on PR 1001 by charlie (APPROVED)
  db.prepare(
    "INSERT INTO review (review_id, pr_id, reviewer_user_id, state, submitted_at) VALUES (?, ?, ?, ?, ?)",
  ).run(5001, 1001, 103, "APPROVED", "2024-01-05T00:00:00Z");
}

let db: Database;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let bearerToken: string;

beforeEach(async () => {
  db = makeTestDb();
  seedData(db);
  const { token_plaintext } = await issueToken(db, "test");
  bearerToken = token_plaintext;
  server = startReadApiServer({ db, port: 0, hostname: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop(true);
  db.close();
});

describe("GET /api/health", () => {
  test("returns 200 without auth", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("auth guard", () => {
  test("GET /api/prs without bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/prs`);
    expect(res.status).toBe(401);
  });

  test("GET /api/prs/:id without bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/prs/1001`);
    expect(res.status).toBe(401);
  });

  test("GET /api/repos without bearer returns 401", async () => {
    const res = await fetch(`${baseUrl}/api/repos`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/prs", () => {
  test("state=closed returns only closed PRs", async () => {
    const res = await fetch(`${baseUrl}/api/prs?state=closed`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { state: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.state).toBe("closed");
    }
  });

  test("state=all returns both open and closed PRs from active repos", async () => {
    const res = await fetch(`${baseUrl}/api/prs?state=all`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { state: string; github_pr_id: number }[];
    const states = new Set(rows.map((r) => r.state));
    expect(states.has("open")).toBe(true);
    expect(states.has("closed")).toBe(true);
    // PR 1003 is in inactive repo — must not appear
    const ids = rows.map((r) => r.github_pr_id);
    expect(ids.includes(1003)).toBe(false);
  });

  test("author filter by login returns only matching PRs", async () => {
    const res = await fetch(`${baseUrl}/api/prs?state=all&author=alice`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { author_login: string }[];
    // PR 1001 (alice, active repo) — PR 1003 (alice, disabled repo) excluded
    expect(rows.length).toBe(1);
    for (const row of rows) {
      expect(row.author_login).toBe("alice");
    }
  });

  test("soft-disabled repo PRs excluded from state=all", async () => {
    const res = await fetch(`${baseUrl}/api/prs?state=all`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { github_pr_id: number }[];
    const ids = rows.map((r) => r.github_pr_id);
    expect(ids.includes(1003)).toBe(false);
  });
});

describe("GET /api/prs/:id", () => {
  test("returns PR detail with reviews array joined with reviewer person", async () => {
    const res = await fetch(`${baseUrl}/api/prs/1001`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      github_pr_id: number;
      state: string;
      reviews: { state: string; reviewer: { login: string } }[];
    };
    expect(detail.github_pr_id).toBe(1001);
    expect(detail.state).toBe("open");
    expect(Array.isArray(detail.reviews)).toBe(true);
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews.at(0)?.state).toBe("APPROVED");
    expect(detail.reviews.at(0)?.reviewer.login).toBe("charlie");
  });

  test("unknown PR returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/prs/99999`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(404);
  });

  test("PR in disabled repo returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/prs/1003`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/repos", () => {
  test("returns active repos with pr_count and open_count", async () => {
    const res = await fetch(`${baseUrl}/api/repos`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    expect(res.status).toBe(200);
    const repos = (await res.json()) as {
      repo_id: number;
      name: string;
      pr_count: number;
      open_count: number;
      active: number;
    }[];
    // Only the active repo should be listed
    expect(repos).toHaveLength(1);
    const repo = repos.at(0);
    expect(repo?.repo_id).toBe(1);
    expect(repo?.name).toBe("hello-world");
    expect(repo?.active).toBe(1);
    // 2 PRs in active repo (1001 open + 1002 closed)
    expect(repo?.pr_count).toBe(2);
    // 1 open PR
    expect(repo?.open_count).toBe(1);
  });
});
