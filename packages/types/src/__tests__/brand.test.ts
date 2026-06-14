import { expect, test } from "bun:test";
import type { GitHubRepoId, GitHubUserId } from "../branded";
import { asRepoId, asUserId } from "../branded";

test("asUserId creates valid branded type", () => {
  const id = asUserId(42);
  expect(id as number).toBe(42);
});

test("asUserId rejects non-positive integers", () => {
  expect(() => asUserId(0)).toThrow();
  expect(() => asUserId(-1)).toThrow();
});

test("brand types are incompatible at compile time", () => {
  const userId = asUserId(1);
  const repoId = asRepoId(1);
  // @ts-expect-error GitHubUserId is not assignable to GitHubRepoId
  const _bad: GitHubRepoId = userId;
  // @ts-expect-error GitHubRepoId is not assignable to GitHubUserId
  const _bad2: GitHubUserId = repoId;
  expect(userId as number).toBe(1);
  expect(repoId as number).toBe(1);
});
