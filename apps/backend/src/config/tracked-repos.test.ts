import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuplicateRepoError,
  getActiveRepos,
  loadTrackedRepos,
  OrgMismatchError,
  syncToDb,
} from "./tracked-repos";

function createTempYaml(content: string): string {
  const path = join(tmpdir(), `tracked-repos-${Date.now()}.yaml`);
  writeFileSync(path, content, "utf8");
  return path;
}

function openTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  // Create repository table
  db.exec(`
    CREATE TABLE repository (
      repo_id INTEGER PRIMARY KEY,
      owner_login TEXT NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
      added_at TEXT NOT NULL
    )
  `);

  return db;
}

test("loadTrackedRepos: valid YAML loads into typed TrackedRepoConfig", () => {
  const yaml = `
org: myorg
repos:
  - repo_id: 1
    owner: myorg
    name: repo1
  - repo_id: 2
    owner: myorg
    name: repo2
`;
  const path = createTempYaml(yaml);
  const config = loadTrackedRepos(path);

  expect(config.org).toBe("myorg");
  expect(config.repos).toHaveLength(2);
  expect(config.repos[0]).toEqual({ repo_id: 1, owner: "myorg", name: "repo1" });
  expect(config.repos[1]).toEqual({ repo_id: 2, owner: "myorg", name: "repo2" });
});

test("loadTrackedRepos: duplicate repo_id throws DuplicateRepoError", () => {
  const yaml = `
org: myorg
repos:
  - repo_id: 1
    owner: myorg
    name: repo1
  - repo_id: 1
    owner: myorg
    name: repo2
`;
  const path = createTempYaml(yaml);

  expect(() => loadTrackedRepos(path)).toThrow(DuplicateRepoError);
});

test("loadTrackedRepos: owner mismatching org throws OrgMismatchError", () => {
  const yaml = `
org: myorg
repos:
  - repo_id: 1
    owner: otherorg
    name: repo1
`;
  const path = createTempYaml(yaml);

  expect(() => loadTrackedRepos(path)).toThrow(OrgMismatchError);
});

test("loadTrackedRepos: case-insensitive org matching", () => {
  const yaml = `
org: MyOrg
repos:
  - repo_id: 1
    owner: myorg
    name: repo1
`;
  const path = createTempYaml(yaml);
  const config = loadTrackedRepos(path);

  expect(config.org).toBe("MyOrg");
  expect(config.repos[0]?.owner).toBe("myorg");
});

test("loadTrackedRepos: missing org field throws error", () => {
  const yaml = `
repos:
  - repo_id: 1
    owner: myorg
    name: repo1
`;
  const path = createTempYaml(yaml);

  expect(() => loadTrackedRepos(path)).toThrow("'org' must be a non-empty string");
});

test("loadTrackedRepos: empty repos array throws error", () => {
  const yaml = `
org: myorg
repos: []
`;
  const path = createTempYaml(yaml);

  expect(() => loadTrackedRepos(path)).toThrow("'repos' must be a non-empty array");
});

test("loadTrackedRepos: missing repo_id throws error", () => {
  const yaml = `
org: myorg
repos:
  - owner: myorg
    name: repo1
`;
  const path = createTempYaml(yaml);

  expect(() => loadTrackedRepos(path)).toThrow("integer 'repo_id'");
});

test("loadTrackedRepos: non-integer repo_id throws error", () => {
  const yaml = `
org: myorg
repos:
  - repo_id: "not-a-number"
    owner: myorg
    name: repo1
`;
  const path = createTempYaml(yaml);

  expect(() => loadTrackedRepos(path)).toThrow("integer 'repo_id'");
});

test("syncToDb: upserts repos from config with active=1", () => {
  const db = openTestDb();
  const config = {
    org: "myorg",
    repos: [
      { repo_id: 1, owner: "myorg", name: "repo1" },
      { repo_id: 2, owner: "myorg", name: "repo2" },
    ],
  };

  const report = syncToDb(db, config);

  expect(report.upserted).toBe(2);
  expect(report.disabled).toBe(0);

  const repos = db
    .prepare("SELECT repo_id, owner_login, name, active FROM repository ORDER BY repo_id")
    .all() as Array<{ repo_id: number; owner_login: string; name: string; active: number }>;

  expect(repos).toHaveLength(2);
  expect(repos[0]).toEqual({
    repo_id: 1,
    owner_login: "myorg",
    name: "repo1",
    active: 1,
  });
  expect(repos[1]).toEqual({
    repo_id: 2,
    owner_login: "myorg",
    name: "repo2",
    active: 1,
  });

  db.close();
});

test("syncToDb: soft-disables repos absent from config", () => {
  const db = openTestDb();

  // Pre-populate with 3 repos
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "myorg", "repo1", 1, "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(2, "myorg", "repo2", 1, "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(3, "myorg", "repo3", 1, "2026-01-01T00:00:00Z");

  // Sync with only repos 1 and 2
  const config = {
    org: "myorg",
    repos: [
      { repo_id: 1, owner: "myorg", name: "repo1" },
      { repo_id: 2, owner: "myorg", name: "repo2" },
    ],
  };

  const report = syncToDb(db, config);

  expect(report.disabled).toBe(1);

  const repos = db
    .prepare("SELECT repo_id, active FROM repository ORDER BY repo_id")
    .all() as Array<{ repo_id: number; active: number }>;

  expect(repos[0]).toEqual({ repo_id: 1, active: 1 });
  expect(repos[1]).toEqual({ repo_id: 2, active: 1 });
  expect(repos[2]).toEqual({ repo_id: 3, active: 0 });

  db.close();
});

test("syncToDb: previously-present rows keep their existing PRs untouched", () => {
  const db = openTestDb();

  // Create pull_request table with FK to repository
  db.exec(`
    CREATE TABLE person (
      user_id INTEGER PRIMARY KEY,
      login TEXT NOT NULL,
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

  // Pre-populate with repo and PR
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "myorg", "repo1", 1, "2026-01-01T00:00:00Z");
  db.prepare("INSERT INTO person (user_id, login, first_seen_at) VALUES (?, ?, ?)").run(
    1,
    "author",
    "2026-01-01T00:00:00Z",
  );
  db.prepare(
    `INSERT INTO pull_request
       (github_pr_id, node_id, number, repo_id, author_user_id, state, draft,
        title, head_sha, created_at, updated_at, html_url, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    100,
    "PR_100",
    1,
    1,
    1,
    "open",
    0,
    "Test PR",
    "abc123",
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
    "http://example.com",
    "2026-01-01T00:00:00Z",
  );

  // Sync with same repo
  const config = {
    org: "myorg",
    repos: [{ repo_id: 1, owner: "myorg", name: "repo1" }],
  };

  syncToDb(db, config);

  // Verify PR still exists
  const prs = db
    .prepare("SELECT github_pr_id, number FROM pull_request WHERE repo_id = 1")
    .all() as Array<{ github_pr_id: number; number: number }>;

  expect(prs).toHaveLength(1);
  expect(prs[0]).toEqual({ github_pr_id: 100, number: 1 });

  db.close();
});

test("syncToDb: adding new repo to config inserts repository row with active=1", () => {
  const db = openTestDb();

  // Pre-populate with one repo
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "myorg", "repo1", 1, "2026-01-01T00:00:00Z");

  // Sync with two repos (one new)
  const config = {
    org: "myorg",
    repos: [
      { repo_id: 1, owner: "myorg", name: "repo1" },
      { repo_id: 2, owner: "myorg", name: "repo2" },
    ],
  };

  const report = syncToDb(db, config);

  // ON CONFLICT DO UPDATE counts both the existing and new repo as changes
  expect(report.upserted).toBe(2);
  expect(report.disabled).toBe(0);

  const repos = db
    .prepare("SELECT repo_id, active FROM repository ORDER BY repo_id")
    .all() as Array<{ repo_id: number; active: number }>;

  expect(repos).toHaveLength(2);
  expect(repos[0]).toEqual({ repo_id: 1, active: 1 });
  expect(repos[1]).toEqual({ repo_id: 2, active: 1 });

  db.close();
});

test("getActiveRepos: returns only active repos", () => {
  const db = openTestDb();

  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "myorg", "repo1", 1, "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(2, "myorg", "repo2", 0, "2026-01-01T00:00:00Z");
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(3, "myorg", "repo3", 1, "2026-01-01T00:00:00Z");

  const active = getActiveRepos(db);

  expect(active).toHaveLength(2);
  expect(active[0]).toEqual({ repo_id: 1, owner_login: "myorg", name: "repo1" });
  expect(active[1]).toEqual({ repo_id: 3, owner_login: "myorg", name: "repo3" });

  db.close();
});

test("getActiveRepos: returns empty array when no active repos", () => {
  const db = openTestDb();

  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "myorg", "repo1", 0, "2026-01-01T00:00:00Z");

  const active = getActiveRepos(db);

  expect(active).toHaveLength(0);

  db.close();
});
