import type { Database } from "bun:sqlite";
import type { Octokit } from "@octokit/rest";
import type { GitHubPullRequest } from "@repo/types";
import type { RepoSummary } from "../config/tracked-repos.ts";
import { listPullsForRepo } from "../github/client.ts";
import { upsertPullRequestFromRestPayload } from "../handlers/pull-request.ts";
import { log } from "../logging/index.ts";

export type ReconcileReport = {
  repos: number;
  upserted: number;
  drift_closed: number;
  duration_ms: number;
};

/**
 * Optional dependency overrides. Used by tests to inject a stub `listPulls`
 * function without globally replacing the `../github/client.ts` module
 * (which would pollute other test files that import from it).
 */
export type ReconcileDeps = {
  listPulls?: (
    client: Octokit,
    owner: string,
    repo: string,
    state: "open" | "closed" | "all",
  ) => Promise<GitHubPullRequest[]>;
};

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * On-startup reconciliation. Syncs DB state with GitHub for every active repo:
 *   1. Lists all PRs (state=all, sorted by updated desc).
 *   2. Filters to PRs updated after a cutoff (90 days for first run, last_reconciled - 7 days otherwise).
 *   3. Upserts each PR through the same path used by webhooks
 *      (`upsertPullRequestFromRestPayload`), which preserves the ghost guard and ordering fence.
 *   4. Drift detection: any PR still open in the DB whose id is not in the remote open set is
 *      forced to `closed`. closed_at comes from the remote payload when available, otherwise
 *      the current timestamp (fallback drift — covers PRs older than the page window).
 *   5. Writes `repo_state.last_reconciled_at` so subsequent runs use the 7-day re-page window.
 *
 * A null client (missing GITHUB_RECONCILE_TOKEN) logs a warning and returns an empty report.
 * Per-repo exceptions are caught and logged so one bad repo doesn't crash the whole sweep.
 */
export async function reconcileAll(
  db: Database,
  client: Octokit | null,
  activeRepos: RepoSummary[],
  deps: ReconcileDeps = {},
): Promise<ReconcileReport> {
  const listPulls = deps.listPulls ?? listPullsForRepo;
  const start = Date.now();

  if (!client) {
    log("warn", "reconciliation skipped: no GITHUB_RECONCILE_TOKEN", {
      event: "reconcile",
      outcome: "ignored",
    });
    return {
      repos: 0,
      upserted: 0,
      drift_closed: 0,
      duration_ms: Date.now() - start,
    };
  }

  let totalUpserted = 0;
  let totalDriftClosed = 0;

  for (const repo of activeRepos) {
    try {
      const repoStart = Date.now();

      const repoState = db
        .query("SELECT last_reconciled_at FROM repo_state WHERE repo_id = ?")
        .get(repo.repo_id) as { last_reconciled_at: string } | null;

      const cutoffDate = repoState
        ? new Date(Date.parse(repoState.last_reconciled_at) - SEVEN_DAYS_MS)
        : new Date(Date.now() - NINETY_DAYS_MS);

      const remotePrs = await listPulls(client, repo.owner_login, repo.name, "all");

      const relevantPrs = remotePrs.filter((pr) => new Date(pr.updated_at) >= cutoffDate);

      for (const pr of relevantPrs) {
        upsertPullRequestFromRestPayload(db, pr, repo.repo_id);
        totalUpserted++;
      }

      const remoteOpenIds = new Set(
        remotePrs.filter((pr) => pr.state === "open").map((pr) => pr.id),
      );

      const dbOpenPrs = db
        .query("SELECT github_pr_id FROM pull_request WHERE repo_id = ? AND state = 'open'")
        .all(repo.repo_id) as { github_pr_id: number }[];

      for (const dbPr of dbOpenPrs) {
        if (!remoteOpenIds.has(dbPr.github_pr_id)) {
          const remotePr = remotePrs.find((p) => p.id === dbPr.github_pr_id);
          const nowIso = new Date().toISOString();
          const closedAt = remotePr?.closed_at ?? nowIso;

          db.prepare(
            "UPDATE pull_request SET state = 'closed', closed_at = ?, last_event_at = ? WHERE github_pr_id = ?",
          ).run(closedAt, nowIso, dbPr.github_pr_id);
          totalDriftClosed++;
        }
      }

      const reconciledAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO repo_state (repo_id, last_reconciled_at) VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET last_reconciled_at = excluded.last_reconciled_at`,
      ).run(repo.repo_id, reconciledAt);

      log("info", "repo reconciled", {
        event: "reconcile",
        repo_id: repo.repo_id,
        outcome: "applied",
        duration_ms: Date.now() - repoStart,
      });
    } catch (err: unknown) {
      const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
      log("error", "repo reconcile failed", {
        event: "reconcile",
        repo_id: repo.repo_id,
        outcome: "rejected",
        error_class: errorClass,
      });
    }
  }

  return {
    repos: activeRepos.length,
    upserted: totalUpserted,
    drift_closed: totalDriftClosed,
    duration_ms: Date.now() - start,
  };
}
