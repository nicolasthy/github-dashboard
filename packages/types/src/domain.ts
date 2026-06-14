export type PullRequest = {
  github_pr_id: number;
  node_id: string;
  number: number;
  repo_id: number;
  author_user_id: number;
  state: "open" | "closed";
  draft: 0 | 1;
  title: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  html_url: string;
  last_event_at: string;
};

export type Repository = {
  repo_id: number;
  owner_login: string;
  name: string;
  active: 0 | 1;
  added_at: string;
};

export type Person = {
  user_id: number;
  login: string;
  avatar_url: string | null;
  first_seen_at: string;
};

export type Review = {
  review_id: number;
  pr_id: number;
  reviewer_user_id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  submitted_at: string;
};

export type DeliveryLog = {
  delivery_id: string;
  event: string;
  action: string | null;
  received_at: string;
  processed_at: string | null;
  outcome: "applied" | "dedup" | "stale" | "rejected" | "ignored";
};

export type RepoState = {
  repo_id: number;
  last_reconciled_at: string;
};

export type ApiToken = {
  token_id: string;
  hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
};
