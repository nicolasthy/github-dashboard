import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { handlePullRequestReview } from "./pull-request-review";

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

    CREATE TABLE review (
      review_id INTEGER PRIMARY KEY,
      pr_id INTEGER NOT NULL REFERENCES pull_request(github_pr_id) ON DELETE CASCADE,
      reviewer_user_id INTEGER NOT NULL REFERENCES person(user_id),
      state TEXT NOT NULL CHECK(state IN ('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED')),
      submitted_at TEXT NOT NULL
    );
  `);

  // Seed: repo, author person, and a parent PR
  db.exec(`
    INSERT INTO repository (repo_id, owner_login, name, active, added_at)
    VALUES (1, 'acme', 'myrepo', 1, '2024-01-01T00:00:00Z');

    INSERT INTO person (user_id, login, avatar_url, first_seen_at)
    VALUES (1, 'author', 'https://example.com/author.png', '2024-01-01T00:00:00Z');

    INSERT INTO pull_request (
      github_pr_id, node_id, number, repo_id, author_user_id,
      state, draft, title, head_sha,
      created_at, updated_at, closed_at, merged_at,
      html_url, last_event_at
    ) VALUES (
      100, 'PR_abc', 42, 1, 1,
      'open', 0, 'My PR', 'abc123',
      '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', NULL, NULL,
      'https://github.com/acme/myrepo/pull/42', '2024-01-01T00:00:00Z'
    );
  `);

  return db;
}

function makeReviewPayload(action: string, reviewState: string, reviewId = 200, prId = 100) {
  return {
    action,
    review: {
      id: reviewId,
      user: { id: 99, login: "reviewer", avatar_url: "https://example.com/reviewer.png" },
      state: reviewState,
      submitted_at: "2024-06-01T12:00:00Z",
    },
    pull_request: { id: prId },
    repository: { id: 1, name: "myrepo", owner: { id: 1, login: "acme", avatar_url: "" } },
  };
}

let db: Database;

beforeEach(() => {
  db = makeTestDb();
});

// 1. submitted action inserts review with mapped state
test("submitted action inserts review with correct mapped state", () => {
  const payload = makeReviewPayload("submitted", "approved");
  const result = handlePullRequestReview(db, payload);

  expect(result).toBe("applied");

  const row = db
    .query("SELECT state, pr_id, reviewer_user_id FROM review WHERE review_id = ?")
    .get(200) as { state: string; pr_id: number; reviewer_user_id: number } | null;

  expect(row).not.toBeNull();
  expect(row?.state).toBe("APPROVED");
  expect(row?.pr_id).toBe(100);
  expect(row?.reviewer_user_id).toBe(99);
});

// 2. dismissed action sets state='DISMISSED' regardless of payload.review.state
test("dismissed action forces state to DISMISSED regardless of review.state", () => {
  const payload = makeReviewPayload("dismissed", "approved"); // state says approved but action says dismissed
  const result = handlePullRequestReview(db, payload);

  expect(result).toBe("applied");

  const row = db.query("SELECT state FROM review WHERE review_id = ?").get(200) as {
    state: string;
  } | null;

  expect(row?.state).toBe("DISMISSED");
});

// 3. Missing parent PR → 'rejected', no row inserted
test("missing parent PR returns rejected and inserts no review row", () => {
  const payload = makeReviewPayload("submitted", "approved", 201, 9999); // pr id 9999 doesn't exist
  const result = handlePullRequestReview(db, payload);

  expect(result).toBe("rejected");

  const row = db.query("SELECT review_id FROM review WHERE review_id = ?").get(201);

  expect(row).toBeNull();
});

// 4. Unsupported action returns 'ignored'
test("unsupported action returns ignored", () => {
  const payload = makeReviewPayload("requested", "approved");
  const result = handlePullRequestReview(db, payload);

  expect(result).toBe("ignored");

  const row = db.query("SELECT review_id FROM review WHERE review_id = ?").get(200);
  expect(row).toBeNull();
});

// 5. edited action upserts review (updates state)
test("edited action updates existing review state", () => {
  // Insert initial review
  db.exec(`
    INSERT INTO person (user_id, login, avatar_url, first_seen_at)
    VALUES (99, 'reviewer', 'https://example.com/reviewer.png', '2024-01-01T00:00:00Z');

    INSERT INTO review (review_id, pr_id, reviewer_user_id, state, submitted_at)
    VALUES (200, 100, 99, 'COMMENTED', '2024-06-01T10:00:00Z');
  `);

  const payload = makeReviewPayload("edited", "changes_requested");
  const result = handlePullRequestReview(db, payload);

  expect(result).toBe("applied");

  const row = db.query("SELECT state FROM review WHERE review_id = ?").get(200) as {
    state: string;
  } | null;

  expect(row?.state).toBe("CHANGES_REQUESTED");
});
