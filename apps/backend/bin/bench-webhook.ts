/**
 * T23 — Inline write-path benchmark harness.
 *
 * Boots the webhook server in-process against an in-memory SQLite DB, seeds the
 * minimum rows the production write path requires (1 person + 1 active repository),
 * then sends NUM_REQUESTS signed `pull_request.synchronize` POSTs and reports
 * p50 / p95 / p99 / max latency. Exits 0 iff p99 is below P99_THRESHOLD_MS.
 *
 * Important: the bench measures the REAL production dispatch path — it does NOT
 * mock the handler or short-circuit the dedup table, because the SLO must hold
 * for the actual code that runs in production.
 */

import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { log } from "../src/logging/index.ts";
import { startWebhookServer } from "../src/server/webhook.ts";

const BENCH_SECRET = "bench-secret-key";
const BENCH_PORT = 18787;
const NUM_REQUESTS = 1000;
const P99_THRESHOLD_MS = 500;

function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main(): Promise<void> {
  // 1. Set up test environment — secret is captured in closure at startWebhookServer time.
  process.env["GITHUB_WEBHOOK_SECRET"] = BENCH_SECRET;
  process.env["GITHUB_ORG"] = "bench-org";
  process.env["PR_TRACKER_DB"] = ":memory:";
  process.env["LOG_PATH"] = "/tmp/bench-webhook.log";

  // 2. Open in-memory DB and run migrations (production schema, no shortcuts).
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  // 3. Seed minimal rows the handler requires to reach the upsert transaction:
  //    one person (PR author) + one active repository.
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO person (user_id, login, avatar_url, first_seen_at) VALUES (?, ?, ?, ?)",
  ).run(1, "bench-user", "https://example.com/avatar", now);
  db.prepare(
    "INSERT INTO repository (repo_id, owner_login, name, active, added_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "bench-org", "bench-repo", 1, now);

  // 4. Start webhook server on a fixed loopback port.
  const server = startWebhookServer({ db, port: BENCH_PORT, hostname: "127.0.0.1" });
  const url = `http://127.0.0.1:${BENCH_PORT}/webhook`;

  // 5. Send NUM_REQUESTS synthetic pull_request.synchronize deliveries.
  const latencies: number[] = [];
  let nonOkCount = 0;

  for (let i = 1; i <= NUM_REQUESTS; i++) {
    const payload = JSON.stringify({
      action: "synchronize",
      pull_request: {
        id: i,
        node_id: `node_${i}`,
        number: i,
        state: "open",
        draft: false,
        title: `PR ${i}`,
        user: {
          id: 1,
          login: "bench-user",
          avatar_url: "https://example.com/avatar",
        },
        head: { sha: `sha${i}` },
        created_at: now,
        // Distinct, monotonically increasing updated_at so the ordering fence
        // never marks a request as stale on the second pass through the same id.
        updated_at: new Date(Date.now() + i).toISOString(),
        closed_at: null,
        merged_at: null,
        html_url: `https://github.com/bench-org/bench-repo/pull/${i}`,
      },
      repository: {
        id: 1,
        name: "bench-repo",
        owner: {
          id: 1,
          login: "bench-org",
          avatar_url: "https://example.com/avatar",
        },
      },
    });

    const sig = signPayload(payload, BENCH_SECRET);
    const deliveryId = `bench-delivery-${i}`;

    const start = performance.now();
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sig,
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": deliveryId,
      },
      body: payload,
    });
    const elapsed = performance.now() - start;
    latencies.push(elapsed);

    // Drain the response body so the next fetch isn't blocked on socket state.
    await resp.text();

    if (!resp.ok) {
      nonOkCount++;
      process.stderr.write(`Request ${i} failed with status ${resp.status}\n`);
    }
  }

  // 6. Stop server cleanly so the script can exit.
  await server.stop(true);
  db.close();

  // 7. Compute percentiles.
  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies[latencies.length - 1] ?? 0;

  process.stdout.write(`Bench results (${NUM_REQUESTS} requests):\n`);
  process.stdout.write(`  p50=${p50.toFixed(1)}ms\n`);
  process.stdout.write(`  p95=${p95.toFixed(1)}ms\n`);
  process.stdout.write(`  p99=${p99.toFixed(1)}ms\n`);
  process.stdout.write(`  max=${max.toFixed(1)}ms\n`);
  process.stdout.write(`  non-2xx=${nonOkCount}\n`);

  if (p99 >= P99_THRESHOLD_MS) {
    log("error", "bench failed", {
      event: "bench_fail",
      outcome: "rejected",
      duration_ms: p99,
    });
    process.stderr.write(`FAIL: p99=${p99.toFixed(1)}ms >= ${P99_THRESHOLD_MS}ms threshold\n`);
    process.exit(1);
  }

  process.stdout.write(`PASS: p99=${p99.toFixed(1)}ms < ${P99_THRESHOLD_MS}ms\n`);
  process.exit(0);
}

await main();
