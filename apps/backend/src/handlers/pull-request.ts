import type { Database } from "bun:sqlite";
import type { DeliveryOutcome, GitHubPullRequest, PullRequestEvent } from "@repo/types";

const ALLOWED_ACTIONS = new Set<string>([
  "opened",
  "reopened",
  "closed",
  "converted_to_draft",
  "ready_for_review",
  "synchronize",
  "edited",
]);

const GHOST_USER_ID = 10137;

type PrState = "open" | "closed";

/**
 * Handles a pull_request webhook event.
 *
 * Gates (in order):
 *   1. action allowlist (7 actions) — others → 'ignored'
 *   2. org allowlist (GITHUB_ORG env) — mismatch → 'rejected'
 *   3. repo allowlist (active=1 in repository table) — miss → 'ignored'
 *   4. ghost user guard (id=10137) on NEW PRs → 'rejected'
 *   5. ordering fence (existing.updated_at >= payload.updated_at) → 'stale'
 *
 * On pass: upserts person + pull_request in a single transaction → 'applied'.
 */
export function handlePullRequest(db: Database, payload: PullRequestEvent): DeliveryOutcome {
  const { action, pull_request: pr, repository: repo } = payload;

  if (!ALLOWED_ACTIONS.has(action)) return "ignored";

  const org = process.env["GITHUB_ORG"];
  if (org && repo.owner.login.toLowerCase() !== org.toLowerCase()) {
    return "rejected";
  }

  const repoRow = db
    .query("SELECT repo_id FROM repository WHERE repo_id = ? AND active = 1")
    .get(repo.id) as { repo_id: number } | null;
  if (!repoRow) return "ignored";

  if (pr.user.id === GHOST_USER_ID) {
    const existing = db
      .query("SELECT github_pr_id FROM pull_request WHERE github_pr_id = ?")
      .get(pr.id) as { github_pr_id: number } | null;
    if (!existing) return "rejected";
  }

  const existingPr = db
    .query("SELECT updated_at FROM pull_request WHERE github_pr_id = ?")
    .get(pr.id) as { updated_at: string } | null;
  if (existingPr && existingPr.updated_at >= pr.updated_at) {
    return "stale";
  }

  const upsert = db.transaction(() => {
    upsertPerson(db, pr.user);
    upsertPr(db, pr, repo.id, action);
  });
  upsert();

  return "applied";
}

/**
 * Reconciliation entry point used by T15. Operates on a REST API payload for a
 * single PR after the caller has already filtered by active repositories.
 *
 * Applies ghost guard and ordering fence; skips action/org/repo gates.
 */
export function upsertPullRequestFromRestPayload(
  db: Database,
  pr: GitHubPullRequest,
  repoId: number,
): void {
  if (pr.user.id === GHOST_USER_ID) {
    const existing = db
      .query("SELECT github_pr_id FROM pull_request WHERE github_pr_id = ?")
      .get(pr.id) as { github_pr_id: number } | null;
    if (!existing) return;
  }

  const existingPr = db
    .query("SELECT updated_at FROM pull_request WHERE github_pr_id = ?")
    .get(pr.id) as { updated_at: string } | null;
  if (existingPr && existingPr.updated_at >= pr.updated_at) return;

  const syntheticAction = pr.state === "closed" ? "closed" : "opened";
  const upsert = db.transaction(() => {
    upsertPerson(db, pr.user);
    upsertPr(db, pr, repoId, syntheticAction);
  });
  upsert();
}

function upsertPerson(db: Database, user: { id: number; login: string; avatar_url: string }): void {
  db.prepare(
    `INSERT INTO person (user_id, login, avatar_url, first_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       login = excluded.login,
       avatar_url = excluded.avatar_url`,
  ).run(user.id, user.login, user.avatar_url, new Date().toISOString());
}

function upsertPr(db: Database, pr: GitHubPullRequest, repoId: number, action: string): void {
  let state: PrState = pr.state;
  let closedAt: string | null = pr.closed_at;
  let mergedAt: string | null = pr.merged_at;
  let draft = pr.draft ? 1 : 0;

  if (action === "closed") {
    state = "closed";
  } else if (action === "reopened") {
    state = "open";
    closedAt = null;
    mergedAt = null;
  } else if (action === "converted_to_draft") {
    draft = 1;
  } else if (action === "ready_for_review") {
    draft = 0;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO pull_request (
       github_pr_id, node_id, number, repo_id, author_user_id,
       state, draft, title, head_sha, created_at, updated_at,
       closed_at, merged_at, html_url, last_event_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(github_pr_id) DO UPDATE SET
       state = excluded.state,
       draft = excluded.draft,
       title = excluded.title,
       head_sha = excluded.head_sha,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at,
       merged_at = excluded.merged_at,
       last_event_at = excluded.last_event_at`,
  ).run(
    pr.id,
    pr.node_id,
    pr.number,
    repoId,
    pr.user.id,
    state,
    draft,
    pr.title,
    pr.head.sha,
    pr.created_at,
    pr.updated_at,
    closedAt,
    mergedAt,
    pr.html_url,
    now,
  );
}
