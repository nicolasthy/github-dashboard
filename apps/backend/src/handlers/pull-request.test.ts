import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { GitHubPullRequest, GitHubRepository, PullRequestEvent } from "@repo/types";
import { handlePullRequest, upsertPullRequestFromRestPayload } from "./pull-request";

const ORG = "test-org";
const REPO_ID = 5000;
const PR_ID = 1001;
const AUTHOR_ID = 9001;
const GHOST_USER_ID = 10137;

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
  `);
  return db;
}

function seedActiveRepo(db: Database, repoId: number = REPO_ID, ownerLogin: string = ORG): void {
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, 'test-repo', 1, '2026-01-01T00:00:00Z')",
  ).run(repoId, ownerLogin);
}

function makePr(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    id: PR_ID,
    node_id: "PR_kwDO123",
    number: 42,
    state: "open",
    draft: false,
    title: "Test PR",
    user: { id: AUTHOR_ID, login: "alice", avatar_url: "https://example.com/alice.png" },
    head: { sha: "abc1230000000000000000000000000000000000" },
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    html_url: "https://github.com/test-org/test-repo/pull/42",
    ...overrides,
  };
}

function makeRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: REPO_ID,
    name: "test-repo",
    owner: { id: 1, login: ORG, avatar_url: "https://example.com/org.png" },
    ...overrides,
  };
}

function makeEvent(
  action: string,
  prOverrides: Partial<GitHubPullRequest> = {},
  repoOverrides: Partial<GitHubRepository> = {},
): PullRequestEvent {
  return {
    action,
    pull_request: makePr(prOverrides),
    repository: makeRepo(repoOverrides),
  };
}

type PrRow = {
  github_pr_id: number;
  state: string;
  draft: number;
  title: string;
  head_sha: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  author_user_id: number;
  repo_id: number;
};

function readPr(db: Database, prId: number = PR_ID): PrRow | null {
  return db.query("SELECT * FROM pull_request WHERE github_pr_id = ?").get(prId) as PrRow | null;
}

let db: Database;
let savedOrg: string | undefined;

beforeEach(() => {
  db = makeTestDb();
  savedOrg = process.env["GITHUB_ORG"];
  process.env["GITHUB_ORG"] = ORG;
});

afterEach(() => {
  if (savedOrg === undefined) delete process.env["GITHUB_ORG"];
  else process.env["GITHUB_ORG"] = savedOrg;
  db.close();
});

// ---------------------------------------------------------------------------
// 7 allowed actions update DB
// ---------------------------------------------------------------------------

test("action=opened inserts a row with state=open and returns 'applied'", () => {
  seedActiveRepo(db);
  const outcome = handlePullRequest(db, makeEvent("opened"));
  expect(outcome).toBe("applied");
  const row = readPr(db);
  expect(row).not.toBeNull();
  expect(row?.state).toBe("open");
  expect(row?.draft).toBe(0);
  expect(row?.title).toBe("Test PR");
});

test("action=synchronize updates head_sha and updated_at", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));

  const outcome = handlePullRequest(
    db,
    makeEvent("synchronize", {
      head: { sha: "def4560000000000000000000000000000000000" },
      updated_at: "2026-06-02T00:00:00Z",
    }),
  );
  expect(outcome).toBe("applied");
  const row = readPr(db);
  expect(row?.head_sha).toBe("def4560000000000000000000000000000000000");
  expect(row?.updated_at).toBe("2026-06-02T00:00:00Z");
});

test("action=edited updates title", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));

  const outcome = handlePullRequest(
    db,
    makeEvent("edited", { title: "Renamed PR", updated_at: "2026-06-02T00:00:00Z" }),
  );
  expect(outcome).toBe("applied");
  expect(readPr(db)?.title).toBe("Renamed PR");
});

test("action=converted_to_draft sets draft=1", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened", { draft: false }));

  const outcome = handlePullRequest(
    db,
    makeEvent("converted_to_draft", { draft: true, updated_at: "2026-06-02T00:00:00Z" }),
  );
  expect(outcome).toBe("applied");
  expect(readPr(db)?.draft).toBe(1);
});

test("action=ready_for_review sets draft=0", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened", { draft: true }));

  const outcome = handlePullRequest(
    db,
    makeEvent("ready_for_review", { draft: false, updated_at: "2026-06-02T00:00:00Z" }),
  );
  expect(outcome).toBe("applied");
  expect(readPr(db)?.draft).toBe(0);
});

test("action=closed sets state=closed and stores closed_at + merged_at", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));

  const outcome = handlePullRequest(
    db,
    makeEvent("closed", {
      state: "closed",
      updated_at: "2026-06-02T00:00:00Z",
      closed_at: "2026-06-02T00:00:00Z",
      merged_at: "2026-06-02T00:00:00Z",
    }),
  );
  expect(outcome).toBe("applied");
  const row = readPr(db);
  expect(row?.state).toBe("closed");
  expect(row?.closed_at).toBe("2026-06-02T00:00:00Z");
  expect(row?.merged_at).toBe("2026-06-02T00:00:00Z");
});

test("action=closed without merge stores closed_at and leaves merged_at null", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));

  const outcome = handlePullRequest(
    db,
    makeEvent("closed", {
      state: "closed",
      updated_at: "2026-06-02T00:00:00Z",
      closed_at: "2026-06-02T00:00:00Z",
      merged_at: null,
    }),
  );
  expect(outcome).toBe("applied");
  const row = readPr(db);
  expect(row?.state).toBe("closed");
  expect(row?.closed_at).toBe("2026-06-02T00:00:00Z");
  expect(row?.merged_at).toBeNull();
});

test("action=reopened sets state=open and clears closed_at + merged_at", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));
  handlePullRequest(
    db,
    makeEvent("closed", {
      state: "closed",
      updated_at: "2026-06-02T00:00:00Z",
      closed_at: "2026-06-02T00:00:00Z",
      merged_at: "2026-06-02T00:00:00Z",
    }),
  );

  const outcome = handlePullRequest(
    db,
    makeEvent("reopened", {
      state: "open",
      updated_at: "2026-06-03T00:00:00Z",
      closed_at: null,
      merged_at: null,
    }),
  );
  expect(outcome).toBe("applied");
  const row = readPr(db);
  expect(row?.state).toBe("open");
  expect(row?.closed_at).toBeNull();
  expect(row?.merged_at).toBeNull();
});

// ---------------------------------------------------------------------------
// 8th action (labeled) is ignored
// ---------------------------------------------------------------------------

test("action=labeled returns 'ignored' and writes no row", () => {
  seedActiveRepo(db);
  const outcome = handlePullRequest(db, makeEvent("labeled"));
  expect(outcome).toBe("ignored");
  expect(readPr(db)).toBeNull();
});

test("action=assigned (any non-allowed) returns 'ignored'", () => {
  seedActiveRepo(db);
  expect(handlePullRequest(db, makeEvent("assigned"))).toBe("ignored");
  expect(handlePullRequest(db, makeEvent("review_requested"))).toBe("ignored");
  expect(readPr(db)).toBeNull();
});

// ---------------------------------------------------------------------------
// Org allowlist
// ---------------------------------------------------------------------------

test("org mismatch returns 'rejected' and writes no row", () => {
  seedActiveRepo(db, REPO_ID, "other-org");
  const outcome = handlePullRequest(
    db,
    makeEvent("opened", {}, { owner: { id: 99, login: "other-org", avatar_url: "x" } }),
  );
  expect(outcome).toBe("rejected");
  expect(readPr(db)).toBeNull();
});

// ---------------------------------------------------------------------------
// Repo allowlist
// ---------------------------------------------------------------------------

test("event for repo not in repository table returns 'ignored'", () => {
  // No repository seeded at all
  const outcome = handlePullRequest(db, makeEvent("opened"));
  expect(outcome).toBe("ignored");
  expect(readPr(db)).toBeNull();
});

test("event for repo with active=0 returns 'ignored'", () => {
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, 'test-repo', 0, '2026-01-01T00:00:00Z')",
  ).run(REPO_ID, ORG);
  const outcome = handlePullRequest(db, makeEvent("opened"));
  expect(outcome).toBe("ignored");
  expect(readPr(db)).toBeNull();
});

// ---------------------------------------------------------------------------
// Ghost user guard
// ---------------------------------------------------------------------------

test("ghost user (id=10137) NEW PR returns 'rejected' and writes no row", () => {
  seedActiveRepo(db);
  const outcome = handlePullRequest(
    db,
    makeEvent("opened", {
      user: { id: GHOST_USER_ID, login: "ghost", avatar_url: "https://example.com/ghost.png" },
    }),
  );
  expect(outcome).toBe("rejected");
  expect(readPr(db)).toBeNull();
});

test("ghost user (id=10137) EXISTING PR is allowed to update", () => {
  seedActiveRepo(db);
  // Seed an existing row authored by the ghost (simulates pre-existing PR)
  db.prepare(
    "INSERT INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, 'ghost', 'x', '2026-01-01T00:00:00Z')",
  ).run(GHOST_USER_ID);
  db.prepare(
    `INSERT INTO pull_request
       (github_pr_id, node_id, number, repo_id, author_user_id, state, draft,
        title, head_sha, created_at, updated_at, html_url, last_event_at)
     VALUES (?, 'PR_kwDO123', 42, ?, ?, 'open', 0, 'Old', 'abc',
             '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z',
             'https://example.com/pr', '2026-06-01T00:00:00Z')`,
  ).run(PR_ID, REPO_ID, GHOST_USER_ID);

  const outcome = handlePullRequest(
    db,
    makeEvent("edited", {
      title: "Updated title",
      updated_at: "2026-06-02T00:00:00Z",
      user: { id: GHOST_USER_ID, login: "ghost", avatar_url: "https://example.com/ghost.png" },
    }),
  );
  expect(outcome).toBe("applied");
  expect(readPr(db)?.title).toBe("Updated title");
});

// ---------------------------------------------------------------------------
// Ordering fence
// ---------------------------------------------------------------------------

test("ordering fence: out-of-order opened-after-closed leaves state=closed", () => {
  seedActiveRepo(db);

  // T+2: closed event arrives first
  const closedOutcome = handlePullRequest(
    db,
    makeEvent("closed", {
      state: "closed",
      updated_at: "2026-06-03T00:00:00Z",
      closed_at: "2026-06-03T00:00:00Z",
      merged_at: "2026-06-03T00:00:00Z",
    }),
  );
  expect(closedOutcome).toBe("applied");

  // T+1: opened event arrives second (out of order) — must be stale
  const openedOutcome = handlePullRequest(
    db,
    makeEvent("opened", {
      state: "open",
      updated_at: "2026-06-02T00:00:00Z",
      closed_at: null,
      merged_at: null,
    }),
  );
  expect(openedOutcome).toBe("stale");

  // T+0: synchronize event arrives third — also stale
  const syncOutcome = handlePullRequest(
    db,
    makeEvent("synchronize", {
      updated_at: "2026-06-01T00:00:00Z",
      head: { sha: "should-not-apply-00000000000000000000000" },
    }),
  );
  expect(syncOutcome).toBe("stale");

  // Final state must be closed
  const row = readPr(db);
  expect(row?.state).toBe("closed");
  expect(row?.merged_at).toBe("2026-06-03T00:00:00Z");
  expect(row?.head_sha).toBe("abc1230000000000000000000000000000000000");
});

test("ordering fence: equal updated_at returns 'stale' (>= comparison)", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));
  const outcome = handlePullRequest(db, makeEvent("synchronize"));
  expect(outcome).toBe("stale");
});

// ---------------------------------------------------------------------------
// upsertPullRequestFromRestPayload (reconciliation)
// ---------------------------------------------------------------------------

test("upsertPullRequestFromRestPayload inserts open PR from REST", () => {
  seedActiveRepo(db);
  upsertPullRequestFromRestPayload(db, makePr(), REPO_ID);
  const row = readPr(db);
  expect(row).not.toBeNull();
  expect(row?.state).toBe("open");
});

test("upsertPullRequestFromRestPayload inserts closed PR with state=closed", () => {
  seedActiveRepo(db);
  upsertPullRequestFromRestPayload(
    db,
    makePr({
      state: "closed",
      closed_at: "2026-06-02T00:00:00Z",
      merged_at: "2026-06-02T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    }),
    REPO_ID,
  );
  const row = readPr(db);
  expect(row?.state).toBe("closed");
  expect(row?.closed_at).toBe("2026-06-02T00:00:00Z");
  expect(row?.merged_at).toBe("2026-06-02T00:00:00Z");
});

test("upsertPullRequestFromRestPayload skips ghost user NEW PR", () => {
  seedActiveRepo(db);
  upsertPullRequestFromRestPayload(
    db,
    makePr({
      user: { id: GHOST_USER_ID, login: "ghost", avatar_url: "x" },
    }),
    REPO_ID,
  );
  expect(readPr(db)).toBeNull();
});

test("upsertPullRequestFromRestPayload applies ghost user to EXISTING PR", () => {
  seedActiveRepo(db);
  db.prepare(
    "INSERT INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, 'ghost', 'x', '2026-01-01T00:00:00Z')",
  ).run(GHOST_USER_ID);
  db.prepare(
    `INSERT INTO pull_request
       (github_pr_id, node_id, number, repo_id, author_user_id, state, draft,
        title, head_sha, created_at, updated_at, html_url, last_event_at)
     VALUES (?, 'PR_kwDO123', 42, ?, ?, 'open', 0, 'Old', 'abc',
             '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z',
             'https://example.com/pr', '2026-06-01T00:00:00Z')`,
  ).run(PR_ID, REPO_ID, GHOST_USER_ID);

  upsertPullRequestFromRestPayload(
    db,
    makePr({
      title: "Reconciled title",
      updated_at: "2026-06-02T00:00:00Z",
      user: { id: GHOST_USER_ID, login: "ghost", avatar_url: "x" },
    }),
    REPO_ID,
  );
  expect(readPr(db)?.title).toBe("Reconciled title");
});

test("upsertPullRequestFromRestPayload honors ordering fence", () => {
  seedActiveRepo(db);
  // Seed newer row
  upsertPullRequestFromRestPayload(
    db,
    makePr({
      title: "Newer",
      state: "closed",
      updated_at: "2026-06-03T00:00:00Z",
      closed_at: "2026-06-03T00:00:00Z",
    }),
    REPO_ID,
  );

  // Try to apply older payload
  upsertPullRequestFromRestPayload(
    db,
    makePr({
      title: "Older",
      updated_at: "2026-06-01T00:00:00Z",
    }),
    REPO_ID,
  );

  const row = readPr(db);
  expect(row?.title).toBe("Newer");
  expect(row?.state).toBe("closed");
});

// ---------------------------------------------------------------------------
// Person upsert
// ---------------------------------------------------------------------------

test("opened action upserts the author into person", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));
  const person = db
    .query("SELECT user_id, login, avatar_url FROM person WHERE user_id = ?")
    .get(AUTHOR_ID) as { user_id: number; login: string; avatar_url: string } | null;
  expect(person?.login).toBe("alice");
  expect(person?.avatar_url).toBe("https://example.com/alice.png");
});

test("person upsert refreshes login + avatar_url on conflict", () => {
  seedActiveRepo(db);
  handlePullRequest(db, makeEvent("opened"));

  handlePullRequest(
    db,
    makeEvent("edited", {
      updated_at: "2026-06-02T00:00:00Z",
      user: { id: AUTHOR_ID, login: "alice-renamed", avatar_url: "https://example.com/new.png" },
    }),
  );

  const person = db
    .query("SELECT login, avatar_url FROM person WHERE user_id = ?")
    .get(AUTHOR_ID) as { login: string; avatar_url: string } | null;
  expect(person?.login).toBe("alice-renamed");
  expect(person?.avatar_url).toBe("https://example.com/new.png");
});
