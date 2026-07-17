import type { Database } from "bun:sqlite";
import type { DeliveryOutcome, PullRequestReviewEvent } from "@repo/types";

const ALLOWED_ACTIONS = new Set(["submitted", "dismissed", "edited"]);

export function handlePullRequestReview(
  db: Database,
  payload: PullRequestReviewEvent,
): DeliveryOutcome {
  const { action, review, pull_request: pr } = payload;

  // 1. Action allowlist
  if (!ALLOWED_ACTIONS.has(action)) return "ignored";

  // 2. Require parent PR row to exist
  const parentPr = db
    .query("SELECT github_pr_id FROM pull_request WHERE github_pr_id = ?")
    .get(pr.id) as { github_pr_id: number } | null;
  if (!parentPr) return "rejected";

  // 3. Map review state
  // For 'dismissed' action, state is always 'DISMISSED' regardless of payload.review.state
  let reviewState: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  if (action === "dismissed") {
    reviewState = "DISMISSED";
  } else {
    const rawState = review.state.toUpperCase();
    if (
      rawState === "APPROVED" ||
      rawState === "CHANGES_REQUESTED" ||
      rawState === "COMMENTED" ||
      rawState === "DISMISSED"
    ) {
      reviewState = rawState;
    } else {
      // Unknown state — treat as COMMENTED
      reviewState = "COMMENTED";
    }
  }

  // 4. Upsert reviewer person
  db.prepare(
    `INSERT INTO person (user_id, login, avatar_url, first_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       login = excluded.login,
       avatar_url = excluded.avatar_url`,
  ).run(review.user.id, review.user.login, review.user.avatar_url, new Date().toISOString());

  // 5. Upsert review
  db.prepare(
    `INSERT INTO review (review_id, pr_id, reviewer_user_id, state, submitted_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(review_id) DO UPDATE SET
       state = excluded.state,
       submitted_at = excluded.submitted_at`,
  ).run(review.id, pr.id, review.user.id, reviewState, review.submitted_at);

  return "applied";
}
