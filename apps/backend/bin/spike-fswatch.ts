#!/usr/bin/env bun
/**
 * Spike (T4): observe `fs.watch` event semantics on macOS across
 * different write patterns (direct write, atomic rename, editor save,
 * touch).
 *
 * Output is line-delimited JSON written to stdout. Each line is one of:
 *   { "event": "start",  "target": "...", "durationMs": N, "startedAt": "...", "pid": N }
 *   { "seq": N, "ts": "...", "eventType": "rename" | "change", "filename": "..." | null }
 *   { "event": "error",  "message": "..." }
 *   { "event": "stop",   "stoppedAt": "...", "totalEvents": N, "reason"?: "..." }
 *
 * Usage:
 *   bun apps/backend/bin/spike-fswatch.ts
 *   bun apps/backend/bin/spike-fswatch.ts --path=/tmp/foo.yaml --duration-ms=5000
 *
 * Feeds docs/spikes/fswatch.md and the canonical reload algorithm
 * for T17 (config hot-reload watcher).
 */

import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type EventRecord = {
  readonly seq: number;
  readonly ts: string;
  readonly eventType: "rename" | "change";
  readonly filename: string | null;
};

const DEFAULT_TARGET = "/tmp/spike-test-watched.yaml";
const DEFAULT_DURATION_MS = 10_000;

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(flag));
  return arg === undefined ? undefined : arg.slice(flag.length);
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeLine(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function ensureTarget(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(path)) {
    writeFileSync(path, "# spike-fswatch fixture\n", "utf8");
  }
}

function main(): void {
  const target = getArg("path") ?? DEFAULT_TARGET;
  const rawDuration = getArg("duration-ms");
  const duration = rawDuration === undefined ? DEFAULT_DURATION_MS : Number(rawDuration);
  if (!Number.isFinite(duration) || duration <= 0) {
    process.stderr.write(`invalid --duration-ms: ${String(rawDuration)}\n`);
    process.exit(2);
  }

  ensureTarget(target);

  let seq = 0;
  writeLine({
    event: "start",
    target,
    durationMs: duration,
    startedAt: nowIso(),
    pid: process.pid,
  });

  const watcher = watch(target, (eventType, filename) => {
    seq += 1;
    const record: EventRecord = {
      seq,
      ts: nowIso(),
      eventType: eventType as "rename" | "change",
      filename: filename === null ? null : String(filename),
    };
    writeLine(record);
  });

  watcher.on("error", (err: unknown) => {
    writeLine({ event: "error", message: err instanceof Error ? err.message : String(err) });
  });

  const stop = (reason?: string): void => {
    watcher.close();
    const payload: Record<string, unknown> = {
      event: "stop",
      stoppedAt: nowIso(),
      totalEvents: seq,
    };
    if (reason !== undefined) {
      payload["reason"] = reason;
    }
    writeLine(payload);
    process.exit(0);
  };

  setTimeout(() => stop(), duration);
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main();
