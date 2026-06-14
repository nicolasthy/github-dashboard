import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import type { GitHubPullRequest } from "@repo/types";
import type { RepoSummary } from "../config/tracked-repos.ts";
import { reconcileAll } from "./index.ts";

// `listPulls` is injected as a dep so we never touch the network and never have
// to mock `../github/client.ts` (which would pollute other test files that
// import its real exports — most notably `src/github/client.test.ts`).
const listPullsMock = mock(
  (_client: Octokit, _owner: string, _repo: string, _state: "open" | "closed" | "all") =>
    Promise.resolve<GitHubPullRequest[]>([]),
);

const REPO_ID = 5000;
const OWNER = "test-org";
const REPO_NAME = "test-repo";
const AUTHOR_ID = 9001;
const DAY_MS = 24 * 60 * 60 * 1000;
const fakeClient = {} as unknown as Octokit;
const activeRepo: RepoSummary = { repo_id: REPO_ID, owner_login: OWNER, name: REPO_NAME };

function isoRelative(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString();
}

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
    );
    CREATE TABLE person (
      user_id INTEGER PRIMARY KEY,
      login TEXT NOT NULL,
      avatar_url TEXT,
      first_seen_at TEXT NOT NULL
    );
    CREATE TABLE pull_request (
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
    CREATE TABLE repo_state (
      repo_id INTEGER PRIMARY KEY REFERENCES repository(repo_id) ON DELETE CASCADE,
      last_reconciled_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedActiveRepo(db: Database): void {
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, 1, '2026-01-01T00:00:00Z')",
  ).run(REPO_ID, OWNER, REPO_NAME);
}

function seedAuthor(db: Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, 'alice', 'x', '2026-01-01T00:00:00Z')",
  ).run(AUTHOR_ID);
}

function seedOpenPr(db: Database, prId: number, updatedAt: string): void {
  seedAuthor(db);
  db.prepare(
    `INSERT INTO pull_request
       (github_pr_id, node_id, number, repo_id, author_user_id, state, draft,
        title, head_sha, created_at, updated_at, closed_at, merged_at, html_url, last_event_at)
     VALUES (?, ?, ?, ?, ?, 'open', 0, ?, 'abc1230', ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    prId,
    `PR_${prId}`,
    prId,
    REPO_ID,
    AUTHOR_ID,
    `PR ${prId}`,
    updatedAt,
    updatedAt,
    `https://github.com/${OWNER}/${REPO_NAME}/pull/${prId}`,
    updatedAt,
  );
}

function makePr(
  opts: Partial<Omit<GitHubPullRequest, "id" | "number">> & { id: number; number: number },
): GitHubPullRequest {
  const { id, number, ...rest } = opts;
  return {
    id,
    node_id: `PR_${id}`,
    number,
    state: "open",
    draft: false,
    title: `PR ${id}`,
    user: { id: AUTHOR_ID, login: "alice", avatar_url: "https://example.com/alice.png" },
    head: { sha: "abc1230000000000000000000000000000000000" },
    created_at: isoRelative(20),
    updated_at: isoRelative(5),
    closed_at: null,
    merged_at: null,
    html_url: `https://github.com/${OWNER}/${REPO_NAME}/pull/${number}`,
    ...rest,
  };
}

let db: Database;
let logDir: string;
let logPath: string;
let savedLogPath: string | undefined;

beforeEach(() => {
  db = makeTestDb();
  seedActiveRepo(db);
  logDir = mkdtempSync(join(tmpdir(), "reconcile-log-"));
  logPath = join(logDir, "app.log");
  savedLogPath = process.env["LOG_PATH"];
  process.env["LOG_PATH"] = logPath;
  listPullsMock.mockReset();
  listPullsMock.mockImplementation(() => Promise.resolve<GitHubPullRequest[]>([]));
});

afterEach(() => {
  db.close();
  if (savedLogPath === undefined) delete process.env["LOG_PATH"];
  else process.env["LOG_PATH"] = savedLogPath;
  rmSync(logDir, { recursive: true, force: true });
});

function readLog(): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Test 1: Empty DB + REST returns 3 open + 2 closed PRs
// ---------------------------------------------------------------------------
test("empty DB + REST returns 3 open + 2 closed PRs → 5 rows inserted with correct states", async () => {
  const closedAt = isoRelative(2);
  const remotePrs: GitHubPullRequest[] = [
    makePr({ id: 1, number: 1, state: "open" }),
    makePr({ id: 2, number: 2, state: "open" }),
    makePr({ id: 3, number: 3, state: "open" }),
    makePr({ id: 4, number: 4, state: "closed", closed_at: closedAt, merged_at: closedAt }),
    makePr({ id: 5, number: 5, state: "closed", closed_at: closedAt, merged_at: null }),
  ];
  listPullsMock.mockImplementation(() => Promise.resolve(remotePrs));

  const report = await reconcileAll(db, fakeClient, [activeRepo], { listPulls: listPullsMock });

  expect(report.repos).toBe(1);
  expect(report.upserted).toBe(5);
  expect(report.drift_closed).toBe(0);

  const rows = db
    .query("SELECT github_pr_id, state FROM pull_request ORDER BY github_pr_id")
    .all() as Array<{ github_pr_id: number; state: string }>;
  expect(rows.length).toBe(5);
  expect(rows.filter((r) => r.state === "open").length).toBe(3);
  expect(rows.filter((r) => r.state === "closed").length).toBe(2);
});

// ---------------------------------------------------------------------------
// Test 2: DB has PR #5 open + REST returns #5 as closed
// ---------------------------------------------------------------------------
test("DB has PR #5 open + REST returns #5 as closed → PR #5 marked closed with closed_at from REST", async () => {
  seedOpenPr(db, 5, isoRelative(30));

  const restClosedAt = isoRelative(2);
  const remotePrs: GitHubPullRequest[] = [
    makePr({
      id: 5,
      number: 5,
      state: "closed",
      closed_at: restClosedAt,
      merged_at: restClosedAt,
      updated_at: isoRelative(2),
    }),
  ];
  listPullsMock.mockImplementation(() => Promise.resolve(remotePrs));

  const report = await reconcileAll(db, fakeClient, [activeRepo], { listPulls: listPullsMock });

  const row = db
    .query("SELECT state, closed_at FROM pull_request WHERE github_pr_id = 5")
    .get() as { state: string; closed_at: string | null };
  expect(row.state).toBe("closed");
  expect(row.closed_at).toBe(restClosedAt);
  expect(report.upserted).toBe(1);
  // The upsert step already closed it, so no drift fallback was needed.
  expect(report.drift_closed).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 3: DB has PR #6 open + REST omits #6 → drift fallback
// ---------------------------------------------------------------------------
test("DB has PR #6 open + REST omits #6 entirely → PR #6 marked closed with closed_at = NOW() (fallback drift)", async () => {
  seedOpenPr(db, 6, isoRelative(30));

  // REST omits #6 entirely.
  listPullsMock.mockImplementation(() => Promise.resolve<GitHubPullRequest[]>([]));

  const before = Date.now();
  const report = await reconcileAll(db, fakeClient, [activeRepo], { listPulls: listPullsMock });
  const after = Date.now();

  const row = db
    .query("SELECT state, closed_at FROM pull_request WHERE github_pr_id = 6")
    .get() as { state: string; closed_at: string };
  expect(row.state).toBe("closed");
  expect(row.closed_at).not.toBeNull();
  const closedAtMs = Date.parse(row.closed_at);
  expect(closedAtMs).toBeGreaterThanOrEqual(before);
  expect(closedAtMs).toBeLessThanOrEqual(after);
  expect(report.drift_closed).toBe(1);
  expect(report.upserted).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 4: empty activeRepos list
// ---------------------------------------------------------------------------
test("empty activeRepos → no work done, repos = 0", async () => {
  const report = await reconcileAll(db, fakeClient, [], { listPulls: listPullsMock });
  expect(report.repos).toBe(0);
  expect(report.upserted).toBe(0);
  expect(report.drift_closed).toBe(0);
  expect(listPullsMock).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Test 5: missing token (null client)
// ---------------------------------------------------------------------------
test("missing token (null client) → warning logged, reconcileAll resolves without throw, ReconcileReport.repos = 0", async () => {
  const report = await reconcileAll(db, null, [activeRepo], { listPulls: listPullsMock });
  expect(report.repos).toBe(0);
  expect(report.upserted).toBe(0);
  expect(report.drift_closed).toBe(0);

  const logContent = readLog();
  expect(logContent).toContain("reconciliation skipped: no GITHUB_RECONCILE_TOKEN");
  expect(logContent).toContain(`"level":"warn"`);
  expect(logContent).toContain(`"event":"reconcile"`);
  expect(logContent).toContain(`"outcome":"ignored"`);
  expect(listPullsMock).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Test 6: repo_state.last_reconciled_at updated per repo
// ---------------------------------------------------------------------------
test("repo_state.last_reconciled_at updated for each reconciled repo", async () => {
  listPullsMock.mockImplementation(() => Promise.resolve<GitHubPullRequest[]>([]));

  const before = Date.now();
  await reconcileAll(db, fakeClient, [activeRepo], { listPulls: listPullsMock });
  const after = Date.now();

  const row = db
    .query("SELECT last_reconciled_at FROM repo_state WHERE repo_id = ?")
    .get(REPO_ID) as { last_reconciled_at: string } | null;
  expect(row).not.toBeNull();
  const reconciledMs = Date.parse((row as { last_reconciled_at: string }).last_reconciled_at);
  expect(reconciledMs).toBeGreaterThanOrEqual(before);
  expect(reconciledMs).toBeLessThanOrEqual(after);
});

// ---------------------------------------------------------------------------
// Bonus: per-repo failures don't crash the sweep
// ---------------------------------------------------------------------------
test("per-repo error is caught + logged; subsequent repos still process", async () => {
  const repo2Id = 5001;
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, 1, '2026-01-01T00:00:00Z')",
  ).run(repo2Id, OWNER, "test-repo-2");

  const repo2: RepoSummary = { repo_id: repo2Id, owner_login: OWNER, name: "test-repo-2" };

  let call = 0;
  listPullsMock.mockImplementation(() => {
    call++;
    if (call === 1) return Promise.reject(new Error("boom"));
    return Promise.resolve<GitHubPullRequest[]>([makePr({ id: 99, number: 99, state: "open" })]);
  });

  const report = await reconcileAll(db, fakeClient, [activeRepo, repo2], {
    listPulls: listPullsMock,
  });

  expect(report.repos).toBe(2);
  expect(report.upserted).toBe(1);

  // First repo logged an error.
  const logContent = readLog();
  expect(logContent).toContain("repo reconcile failed");
  expect(logContent).toContain(`"error_class":"Error"`);
  expect(logContent).toContain(`"repo_id":${REPO_ID}`);

  // Second repo upserted the PR.
  const row = db.query("SELECT state FROM pull_request WHERE github_pr_id = 99").get() as {
    state: string;
  } | null;
  expect(row).not.toBeNull();
  expect((row as { state: string }).state).toBe("open");
});
