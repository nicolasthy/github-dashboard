import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type TrackedRepo = {
  repo_id: number;
  owner: string;
  name: string;
};

export type TrackedRepoConfig = {
  org: string;
  repos: TrackedRepo[];
};

export type SyncReport = {
  upserted: number;
  disabled: number;
};

export type RepoSummary = {
  repo_id: number;
  owner_login: string;
  name: string;
};

export class DuplicateRepoError extends Error {
  constructor(repoId: number) {
    super(`Duplicate repo_id in tracked-repos.yaml: ${repoId}`);
    this.name = "DuplicateRepoError";
  }
}

export class OrgMismatchError extends Error {
  constructor(owner: string, org: string) {
    super(`Repo owner '${owner}' does not match org '${org}'`);
    this.name = "OrgMismatchError";
  }
}

export function loadTrackedRepos(path: string): TrackedRepoConfig {
  const content = readFileSync(path, "utf8");
  const raw = parse(content) as unknown;

  // Validate structure
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tracked-repos.yaml must be an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj["org"] !== "string" || obj["org"].trim() === "") {
    throw new Error("tracked-repos.yaml: 'org' must be a non-empty string");
  }
  const org = obj["org"].trim();

  if (!Array.isArray(obj["repos"]) || obj["repos"].length === 0) {
    throw new Error("tracked-repos.yaml: 'repos' must be a non-empty array");
  }

  const repos: TrackedRepo[] = [];
  const seenIds = new Set<number>();

  for (const item of obj["repos"] as unknown[]) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Each repo entry must be an object");
    }
    const repo = item as Record<string, unknown>;

    if (typeof repo["repo_id"] !== "number" || !Number.isInteger(repo["repo_id"])) {
      throw new Error("Each repo must have an integer 'repo_id'");
    }
    if (typeof repo["owner"] !== "string" || repo["owner"].trim() === "") {
      throw new Error("Each repo must have a non-empty 'owner'");
    }
    if (typeof repo["name"] !== "string" || repo["name"].trim() === "") {
      throw new Error("Each repo must have a non-empty 'name'");
    }

    const repoId = repo["repo_id"] as number;
    const owner = (repo["owner"] as string).trim();
    const name = (repo["name"] as string).trim();

    // Check for duplicate repo_id
    if (seenIds.has(repoId)) {
      throw new DuplicateRepoError(repoId);
    }
    seenIds.add(repoId);

    // Check owner matches org (case-insensitive)
    if (owner.toLowerCase() !== org.toLowerCase()) {
      throw new OrgMismatchError(owner, org);
    }

    repos.push({ repo_id: repoId, owner, name });
  }

  return { org, repos };
}

export function syncToDb(db: Database, config: TrackedRepoConfig): SyncReport {
  const now = new Date().toISOString();
  let upserted = 0;
  let disabled = 0;

  const sync = db.transaction(() => {
    // Upsert each config entry with active=1
    for (const repo of config.repos) {
      const result = db
        .prepare(
          `INSERT INTO repository (repo_id, owner_login, name, active, added_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(repo_id) DO UPDATE SET
             owner_login = excluded.owner_login,
             name = excluded.name,
             active = 1`,
        )
        .run(repo.repo_id, repo.owner, repo.name, now);
      if (result.changes > 0) upserted++;
    }

    // Soft-disable repos NOT in config
    const configIds = config.repos.map((r) => r.repo_id);
    if (configIds.length > 0) {
      const placeholders = configIds.map(() => "?").join(",");
      const result = db
        .prepare(`UPDATE repository SET active = 0 WHERE repo_id NOT IN (${placeholders})`)
        .run(...configIds);
      disabled = result.changes;
    } else {
      // No repos in config — disable all
      const result = db.prepare("UPDATE repository SET active = 0").run();
      disabled = result.changes;
    }
  });

  sync();
  return { upserted, disabled };
}

export function getActiveRepos(db: Database): RepoSummary[] {
  return db
    .query("SELECT repo_id, owner_login, name FROM repository WHERE active = 1")
    .all() as RepoSummary[];
}
