import { join } from "node:path";
import { getActiveRepos, loadTrackedRepos, syncToDb } from "./config/tracked-repos.ts";
import { watchTrackedRepos } from "./config/watcher.ts";
import { close, open, selfTest } from "./db/connection.ts";
import { runMigrations } from "./db/migrate.ts";
import { makeClient } from "./github/client.ts";
import { log } from "./logging/index.ts";
import { reconcileAll } from "./reconcile/index.ts";
import { startReadApiServer } from "./server/read-api.ts";
import { startWebhookServer } from "./server/webhook.ts";

// Resolve monorepo root (apps/backend/src/index.ts → ../../..)
const MONOREPO_ROOT = join(import.meta.dir, "..", "..", "..");
const TRACKED_REPOS_PATH =
  process.env["TRACKED_REPOS_PATH"] ?? join(MONOREPO_ROOT, "tracked-repos.yaml");

function main(): void {
  // 1. Assert required env vars
  const requiredEnv = ["GITHUB_WEBHOOK_SECRET", "GITHUB_ORG"] as const;
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      process.stderr.write(`Missing required env var: ${key}\n`);
      process.exit(1);
    }
  }

  // 2. Open DB, run migrations, and run self-test
  const db = open();
  runMigrations(db);
  selfTest();

  // 3. Load tracked repos config
  let config;
  try {
    config = loadTrackedRepos(TRACKED_REPOS_PATH);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to load tracked-repos.yaml: ${msg}\n`);
    process.exit(1);
  }
  syncToDb(db, config);

  // 4. Start config hot-reload watcher
  const watcher = watchTrackedRepos(TRACKED_REPOS_PATH, (newConfig) => {
    syncToDb(db, newConfig);
    log("info", "tracked-repos reloaded", { event: "config_reload", outcome: "applied" });
  });

  // 5. Reconciliation (non-blocking — log and continue on failure)
  const reconcileToken = process.env["GITHUB_RECONCILE_TOKEN"];
  const client = reconcileToken ? makeClient(reconcileToken) : null;
  const activeRepos = getActiveRepos(db);
  reconcileAll(db, client, activeRepos)
    .then((report) => {
      log("info", "reconciliation complete", {
        event: "reconcile",
        outcome: "applied",
        duration_ms: report.duration_ms,
      });
    })
    .catch((err: unknown) => {
      const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
      log("error", "reconciliation failed", {
        event: "reconcile",
        outcome: "rejected",
        error_class: errorClass,
      });
    });

  // 6. Start both servers
  const webhookServer = startWebhookServer({ db });
  const readApiServer = startReadApiServer({ db });

  // 7. Log startup
  log("info", "startup", { event: "startup", status: 200 });

  // 8. Signal handling — graceful shutdown
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    log("info", "shutdown", { event: "shutdown", reason_code: signal });

    // Stop accepting new connections
    webhookServer.stop(true);
    readApiServer.stop(true);

    // Stop config watcher
    watcher.stop();

    // Close DB
    close(db);

    process.exit(0);
  }

  // Set a 5s hard timeout for shutdown
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(1), 5000).unref();
    shutdown("SIGTERM");
  });

  process.on("SIGINT", () => {
    setTimeout(() => process.exit(1), 5000).unref();
    shutdown("SIGINT");
  });

  // Crash handling
  process.on("uncaughtException", (err: Error) => {
    log("error", "crash", { event: "crash", error_class: err.constructor.name });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const errorClass = reason instanceof Error ? reason.constructor.name : "UnhandledRejection";
    log("error", "crash", { event: "crash", error_class: errorClass });
    process.exit(1);
  });
}

main();
