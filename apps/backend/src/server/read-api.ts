import type { Database } from "bun:sqlite";
import type {
  PullRequestDetail,
  PullRequestListItem,
  RepoSummary,
  ReviewWithReviewer,
} from "@repo/types";
import { log } from "../logging/index.ts";
import { requireBearer } from "./auth.ts";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export type ReadApiServerOpts = {
  db: Database;
  port?: number;
  hostname?: string;
};

export function startReadApiServer(opts: ReadApiServerOpts): ReturnType<typeof Bun.serve> {
  const { db, port = 8788, hostname = "127.0.0.1" } = opts;
  const auth = requireBearer(db);

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const start = Date.now();

      // GET /api/health — no auth
      if (req.method === "GET" && url.pathname === "/api/health") {
        return Response.json({ ok: true });
      }

      // All other routes require auth
      const authResult = await auth(req);
      if (authResult instanceof Response) {
        return authResult;
      }
      const token = authResult;

      try {
        // GET /api/prs
        if (req.method === "GET" && url.pathname === "/api/prs") {
          const state = url.searchParams.get("state") ?? "all";
          const authorParam = url.searchParams.get("author");
          const repoIdParam = url.searchParams.get("repo_id");
          const limitParam = url.searchParams.get("limit");
          const limit = Math.min(Number(limitParam ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);

          // Parse author as either numeric id or login string
          const authorId = authorParam && /^\d+$/.test(authorParam) ? Number(authorParam) : null;
          const authorLogin = authorParam && !/^\d+$/.test(authorParam) ? authorParam : null;
          const repoId = repoIdParam ? Number(repoIdParam) : null;

          const rows = db
            .query(
              `
            SELECT pr.github_pr_id, pr.node_id, pr.number, pr.state, pr.draft,
                   pr.title, pr.head_sha, pr.created_at, pr.updated_at,
                   pr.closed_at, pr.merged_at, pr.html_url, pr.last_event_at,
                   pr.repo_id, r.owner_login, r.name AS repo_name,
                   pr.author_user_id, author.login AS author_login, author.avatar_url AS author_avatar_url
            FROM pull_request pr
            JOIN repository r ON pr.repo_id = r.repo_id
            JOIN person author ON pr.author_user_id = author.user_id
            WHERE r.active = 1
              AND (? = 'all' OR pr.state = ?)
              AND (? IS NULL OR pr.author_user_id = ? OR author.login = ?)
              AND (? IS NULL OR pr.repo_id = ?)
            ORDER BY pr.updated_at DESC
            LIMIT ?
          `,
            )
            .all(
              state,
              state,
              authorParam,
              authorId,
              authorLogin,
              repoId,
              repoId,
              limit,
            ) as PullRequestListItem[];

          const duration = Date.now() - start;
          log("info", "read api prs", {
            event: "read_api",
            token_id: token.token_id,
            status: 200,
            duration_ms: duration,
          });
          return Response.json(rows);
        }

        // GET /api/prs/:id
        const prMatch = url.pathname.match(/^\/api\/prs\/(\d+)$/);
        if (req.method === "GET" && prMatch) {
          const prId = Number(prMatch[1]);

          const pr = db
            .query(
              `
            SELECT pr.github_pr_id, pr.node_id, pr.number, pr.state, pr.draft,
                   pr.title, pr.head_sha, pr.created_at, pr.updated_at,
                   pr.closed_at, pr.merged_at, pr.html_url, pr.last_event_at,
                   pr.repo_id, r.owner_login, r.name AS repo_name,
                   pr.author_user_id, author.login AS author_login, author.avatar_url AS author_avatar_url
            FROM pull_request pr
            JOIN repository r ON pr.repo_id = r.repo_id
            JOIN person author ON pr.author_user_id = author.user_id
            WHERE pr.github_pr_id = ? AND r.active = 1
          `,
            )
            .get(prId) as PullRequestListItem | null;

          if (!pr) {
            return Response.json({ error: "not found" }, { status: 404 });
          }

          const reviews = db
            .query(
              `
            SELECT rv.review_id, rv.state, rv.submitted_at,
                   rv.reviewer_user_id,
                   p.login AS reviewer_login, p.avatar_url AS reviewer_avatar_url
            FROM review rv
            JOIN person p ON rv.reviewer_user_id = p.user_id
            WHERE rv.pr_id = ?
            ORDER BY rv.submitted_at ASC
          `,
            )
            .all(prId) as Array<{
            review_id: number;
            state: string;
            submitted_at: string;
            reviewer_user_id: number;
            reviewer_login: string;
            reviewer_avatar_url: string | null;
          }>;

          const reviewsFormatted: ReviewWithReviewer[] = reviews.map((r) => ({
            review_id: r.review_id,
            state: r.state as ReviewWithReviewer["state"],
            submitted_at: r.submitted_at,
            reviewer: {
              user_id: r.reviewer_user_id,
              login: r.reviewer_login,
              avatar_url: r.reviewer_avatar_url,
            },
          }));

          const detail: PullRequestDetail = { ...pr, reviews: reviewsFormatted };
          const duration = Date.now() - start;
          log("info", "read api pr detail", {
            event: "read_api",
            token_id: token.token_id,
            status: 200,
            duration_ms: duration,
          });
          return Response.json(detail);
        }

        // GET /api/repos
        if (req.method === "GET" && url.pathname === "/api/repos") {
          const repos = db
            .query(
              `
            SELECT r.repo_id, r.owner_login, r.name, r.active, r.added_at,
                   COUNT(pr.github_pr_id) AS pr_count,
                   SUM(CASE WHEN pr.state = 'open' THEN 1 ELSE 0 END) AS open_count
            FROM repository r
            LEFT JOIN pull_request pr ON pr.repo_id = r.repo_id
            WHERE r.active = 1
            GROUP BY r.repo_id
          `,
            )
            .all() as RepoSummary[];

          const duration = Date.now() - start;
          log("info", "read api repos", {
            event: "read_api",
            token_id: token.token_id,
            status: 200,
            duration_ms: duration,
          });
          return Response.json(repos);
        }

        return Response.json({ error: "not found" }, { status: 404 });
      } catch (err: unknown) {
        const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
        const duration = Date.now() - start;
        log("error", "read api error", {
          event: "read_api",
          token_id: token.token_id,
          error_class: errorClass,
          status: 500,
          duration_ms: duration,
        });
        return Response.json({ error: "internal error" }, { status: 500 });
      }
    },
  });

  return server;
}
