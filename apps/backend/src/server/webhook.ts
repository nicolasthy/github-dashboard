import type { Database } from "bun:sqlite";
import type {
  DeliveryOutcome,
  PullRequestEvent,
  PullRequestReviewEvent,
  RepositoryRenamedEvent,
} from "@repo/types";
import { handlePullRequest } from "../handlers/pull-request.ts";
import { handlePullRequestReview } from "../handlers/pull-request-review.ts";
import { handleRepository } from "../handlers/repository.ts";
import { log } from "../logging/index.ts";
import { markOutcome, recordDelivery } from "../webhook/dedup.ts";
import { verifySignature } from "../webhook/verify.ts";

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB

export type WebhookServerOpts = {
  db: Database;
  port?: number;
  hostname?: string;
};

export function startWebhookServer(opts: WebhookServerOpts): ReturnType<typeof Bun.serve> {
  const { db, port = 8787, hostname = "127.0.0.1" } = opts;
  const secret = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";

  const server = Bun.serve({
    hostname,
    port,
    fetch(req: Request): Response | Promise<Response> {
      const url = new URL(req.url);

      // GET /ping — health check for cloudflared
      if (req.method === "GET" && url.pathname === "/ping") {
        return new Response("pong", { status: 200 });
      }

      // POST /webhook
      if (req.method === "POST" && url.pathname === "/webhook") {
        return handleWebhook(req, db, secret);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return server;
}

async function handleWebhook(req: Request, db: Database, secret: string): Promise<Response> {
  const start = Date.now();
  const deliveryId = req.headers.get("X-GitHub-Delivery") ?? "unknown";
  const event = req.headers.get("X-GitHub-Event") ?? "unknown";
  const signatureHeader = req.headers.get("X-Hub-Signature-256");

  try {
    // 1. Read body with size limit
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      log("warn", "webhook body too large", {
        event,
        delivery_id: deliveryId,
        outcome: "rejected",
      });
      return new Response(JSON.stringify({ ok: false, error: "payload too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    const rawBody = Buffer.from(await req.arrayBuffer());
    if (rawBody.length > MAX_BODY_BYTES) {
      log("warn", "webhook body too large", {
        event,
        delivery_id: deliveryId,
        outcome: "rejected",
      });
      return new Response(JSON.stringify({ ok: false, error: "payload too large" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. HMAC verification
    if (!verifySignature(rawBody, signatureHeader, secret)) {
      log("warn", "webhook signature invalid", {
        event,
        delivery_id: deliveryId,
        outcome: "rejected",
      });
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Parse JSON
    const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    const action = typeof payload["action"] === "string" ? payload["action"] : null;

    // 4. Dedup check
    const dedupResult = recordDelivery(db, deliveryId, event, action);
    if (dedupResult === "dup") {
      const duration = Date.now() - start;
      log("info", "webhook dedup", {
        event,
        action: action ?? undefined,
        delivery_id: deliveryId,
        outcome: "dedup",
        duration_ms: duration,
      });
      return new Response(JSON.stringify({ ok: true, outcome: "dedup" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Dispatch to handler
    let outcome: DeliveryOutcome = "ignored";
    if (event === "pull_request") {
      outcome = handlePullRequest(db, payload as unknown as PullRequestEvent);
    } else if (event === "pull_request_review") {
      outcome = handlePullRequestReview(db, payload as unknown as PullRequestReviewEvent);
    } else if (event === "repository") {
      outcome = handleRepository(db, payload as unknown as RepositoryRenamedEvent);
    } else if (event === "ping") {
      outcome = "applied";
    }
    // merge-queue events and others → ignored

    // 6. Record outcome
    markOutcome(db, deliveryId, outcome);

    const duration = Date.now() - start;
    log("info", "webhook processed", {
      event,
      action: action ?? undefined,
      delivery_id: deliveryId,
      outcome,
      duration_ms: duration,
      status: 200,
    });

    return new Response(JSON.stringify({ ok: true, outcome }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const duration = Date.now() - start;
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    log("error", "webhook handler error", {
      event,
      delivery_id: deliveryId,
      outcome: "rejected",
      error_class: errorClass,
      duration_ms: duration,
    });
    markOutcome(db, deliveryId, "rejected");
    return new Response(JSON.stringify({ ok: false, error: "internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
