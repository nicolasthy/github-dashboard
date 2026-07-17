export type PullRequestListItem = {
  github_pr_id: number;
  number: number;
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
  repo_id: number;
  repo_name: string;
  owner_login: string;
  author_user_id: number;
  author_login: string;
  author_avatar_url: string | null;
};

export type ReviewWithReviewer = {
  review_id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  submitted_at: string;
  reviewer: {
    user_id: number;
    login: string;
    avatar_url: string | null;
  };
};

export type PullRequestDetail = PullRequestListItem & {
  reviews: ReviewWithReviewer[];
};

export type RepoSummary = {
  repo_id: number;
  owner_login: string;
  name: string;
  active: 0 | 1;
  added_at: string;
  pr_count: number;
  open_count: number;
};
