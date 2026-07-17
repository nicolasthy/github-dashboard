import type { Database } from "bun:sqlite";
import type { DeliveryOutcome, RepositoryRenamedEvent } from "@repo/types";

export function handleRepository(db: Database, payload: RepositoryRenamedEvent): DeliveryOutcome {
  const { action, repository: repo } = payload;

  // Only handle 'renamed' action
  if (action !== "renamed") return "ignored";

  // Update the repository name and owner_login
  const result = db
    .prepare(`UPDATE repository SET name = ?, owner_login = ? WHERE repo_id = ?`)
    .run(repo.name, repo.owner.login, repo.id);

  // If no row was updated, the repo is not tracked
  if (result.changes === 0) return "ignored";

  return "applied";
}
