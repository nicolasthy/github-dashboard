export type GitHubUserId = number & { readonly __brand: "GitHubUserId" };
export type GitHubRepoId = number & { readonly __brand: "GitHubRepoId" };
export type GitHubPrId = number & { readonly __brand: "GitHubPrId" };
export type GitHubReviewId = number & { readonly __brand: "GitHubReviewId" };

export function asUserId(n: number): GitHubUserId {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid GitHubUserId: ${n}`);
  return n as GitHubUserId;
}

export function asRepoId(n: number): GitHubRepoId {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid GitHubRepoId: ${n}`);
  return n as GitHubRepoId;
}

export function asPrId(n: number): GitHubPrId {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid GitHubPrId: ${n}`);
  return n as GitHubPrId;
}

export function asReviewId(n: number): GitHubReviewId {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid GitHubReviewId: ${n}`);
  return n as GitHubReviewId;
}
