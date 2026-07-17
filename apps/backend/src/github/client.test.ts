import { expect, mock, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { applyRateLimit, listPullsForRepo, makeClient } from "./client";

test("makeClient returns an Octokit instance", () => {
  const client = makeClient("test-token");
  expect(client).toBeInstanceOf(Octokit);
});

test("listPullsForRepo paginates correctly", async () => {
  const mockClient = {
    rest: {
      pulls: {
        list: mock(({ page }: { page: number }) => {
          if (page === 1) {
            return { data: Array.from({ length: 100 }, (_, i) => makePR(i + 1)), headers: {} };
          }
          if (page === 2) {
            return { data: Array.from({ length: 100 }, (_, i) => makePR(i + 101)), headers: {} };
          }
          if (page === 3) {
            return { data: Array.from({ length: 50 }, (_, i) => makePR(i + 201)), headers: {} };
          }
          return { data: [], headers: {} };
        }),
      },
    },
    hook: {
      after: () => {
        /* noop */
      },
    },
  } as unknown as Octokit;

  const pulls = await listPullsForRepo(mockClient, "owner", "repo", "all");
  expect(pulls.length).toBe(250);
  expect(pulls[0]?.id).toBe(1);
  expect(pulls[249]?.id).toBe(250);
});

test("listPullsForRepo maps fields correctly", async () => {
  const mockClient = {
    rest: {
      pulls: {
        list: mock(() => ({
          data: [makePR(42)],
          headers: {},
        })),
      },
    },
    hook: {
      after: () => {
        /* noop */
      },
    },
  } as unknown as Octokit;

  const pulls = await listPullsForRepo(mockClient, "owner", "repo", "open");
  expect(pulls.length).toBe(1);
  const pr = pulls[0];
  if (!pr) throw new Error("Expected at least one pull request");
  expect(pr.id).toBe(42);
  expect(pr.node_id).toBe("node_42");
  expect(pr.number).toBe(42);
  expect(pr.state).toBe("open");
  expect(pr.draft).toBe(false);
  expect(pr.title).toBe("PR 42");
  expect(pr.user.login).toBe("user");
  expect(pr.head.sha).toBe("abc123");
  expect(pr.closed_at).toBeNull();
  expect(pr.merged_at).toBeNull();
});

test("rate-limit hook pauses when remaining < 10", async () => {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  // Capture the wait duration without actually waiting
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const resetTime = Math.floor(Date.now() / 1000) + 60; // 60s from now
    await applyRateLimit({
      "x-ratelimit-remaining": "5",
      "x-ratelimit-reset": String(resetTime),
    });

    expect(delays.length).toBe(1);
    expect(delays[0]).toBeGreaterThan(0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("rate-limit hook does not pause when remaining >= 10", async () => {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  try {
    const resetTime = Math.floor(Date.now() / 1000) + 60;
    await applyRateLimit({
      "x-ratelimit-remaining": "50",
      "x-ratelimit-reset": String(resetTime),
    });

    expect(delays.length).toBe(0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

function makePR(id: number) {
  return {
    id,
    node_id: `node_${id}`,
    number: id,
    state: "open",
    draft: false,
    title: `PR ${id}`,
    user: { id: 1, login: "user", avatar_url: "https://example.com/avatar" },
    head: { sha: "abc123" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    html_url: `https://github.com/owner/repo/pull/${id}`,
  };
}
