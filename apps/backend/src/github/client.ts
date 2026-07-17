import { Octokit } from "@octokit/rest";
import type { GitHubPullRequest } from "@repo/types";

const USER_AGENT = "github-pr-tracker/0.1";

export async function applyRateLimit(headers: Record<string, string | undefined>): Promise<void> {
  const remaining = Number(headers["x-ratelimit-remaining"] ?? "100");
  const reset = Number(headers["x-ratelimit-reset"] ?? "0");
  if (remaining < 10 && reset > 0) {
    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000; // +1s buffer
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

export function makeClient(token: string): Octokit {
  const octokit = new Octokit({
    auth: token,
    userAgent: USER_AGENT,
  });

  // Add rate-limit hook: pause when remaining < 10
  octokit.hook.after("request", async (response) => {
    await applyRateLimit(response.headers as Record<string, string | undefined>);
  });

  return octokit;
}

export async function listPullsForRepo(
  client: Octokit,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "all",
): Promise<GitHubPullRequest[]> {
  const pulls: GitHubPullRequest[] = [];
  let page = 1;

  while (true) {
    const response = await client.rest.pulls.list({
      owner,
      repo,
      state,
      per_page: 100,
      page,
      sort: "updated",
      direction: "desc",
    });

    const items = response.data;
    if (items.length === 0) break;

    for (const item of items) {
      pulls.push({
        id: item.id,
        node_id: item.node_id,
        number: item.number,
        state: item.state as "open" | "closed",
        draft: item.draft ?? false,
        title: item.title,
        user: {
          id: item.user?.id ?? 0,
          login: item.user?.login ?? "",
          avatar_url: item.user?.avatar_url ?? "",
        },
        head: { sha: item.head.sha },
        created_at: item.created_at,
        updated_at: item.updated_at,
        closed_at: item.closed_at ?? null,
        merged_at: item.merged_at ?? null,
        html_url: item.html_url,
      });
    }

    if (items.length < 100) break;
    page++;
  }

  return pulls;
}
