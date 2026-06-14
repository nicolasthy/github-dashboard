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

CREATE TABLE IF NOT EXISTS delivery_log (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','dedup','stale','rejected','ignored'))
);

CREATE TABLE IF NOT EXISTS repo_state (
  repo_id INTEGER PRIMARY KEY REFERENCES repository(repo_id) ON DELETE CASCADE,
  last_reconciled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_token (
  token_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pr_state_repo_updated ON pull_request(state, repo_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_pr_author ON pull_request(author_user_id);
CREATE INDEX IF NOT EXISTS idx_review_pr ON review(pr_id);
CREATE INDEX IF NOT EXISTS idx_delivery_received ON delivery_log(received_at);
CREATE INDEX IF NOT EXISTS idx_repo_active ON repository(active);
