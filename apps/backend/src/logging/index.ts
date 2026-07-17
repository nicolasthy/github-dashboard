import { appendFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error" | "debug";

// Hard-coded allowlist — no payload, no login, no title, no PII
const ALLOWED_FIELDS = new Set([
  "event",
  "action",
  "delivery_id",
  "status",
  "duration_ms",
  "outcome",
  "error_class",
  "repo_id",
  "token_id",
  "reason_code",
]);

function resolveLogPath(): string {
  // logs/app.log relative to apps/backend/
  return join(import.meta.dir, "..", "..", "logs", "app.log");
}

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  // Filter to allowlist only — silently drop non-allowlisted fields
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(key)) {
      filtered[key] = value;
    }
  }

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...filtered,
  });

  const line = `${entry}\n`;

  // Write to log file (append)
  const logPath = process.env["LOG_PATH"] ?? resolveLogPath();
  try {
    appendFileSync(logPath, line, "utf8");
  } catch {
    // If log file write fails, silently continue (don't crash the server)
  }

  // Optionally write to stderr for dev
  if (process.env["LOG_STDERR"] === "1") {
    process.stderr.write(line);
  }
}
