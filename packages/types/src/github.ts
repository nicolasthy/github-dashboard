export type GitHubUser = {
  id: number;
  login: string;
  avatar_url: string;
};

export type GitHubRepository = {
  id: number;
  name: string;
  owner: GitHubUser;
};

export type GitHubPullRequest = {
  id: number;
  node_id: string;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  user: GitHubUser;
  head: { sha: string };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  html_url: string;
};

export type GitHubReview = {
  id: number;
  user: GitHubUser;
  state: string;
  submitted_at: string;
};

export type PullRequestEvent = {
  action: string;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
};

export type PullRequestReviewEvent = {
  action: string;
  review: GitHubReview;
  pull_request: { id: number };
  repository: GitHubRepository;
};

export type RepositoryRenamedEvent = {
  action: "renamed";
  repository: GitHubRepository;
};
