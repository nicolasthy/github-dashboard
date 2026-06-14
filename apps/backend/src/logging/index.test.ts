import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "./index";

// Point log to a temp file for tests
const TEST_LOG = `/tmp/test-app-${Date.now()}.log`;

beforeEach(() => {
  process.env["PR_TRACKER_DB"] = "/tmp/test.db";
  process.env["LOG_PATH"] = TEST_LOG;
});

afterEach(() => {
  if (existsSync(TEST_LOG)) {
    unlinkSync(TEST_LOG);
  }
  delete process.env["LOG_PATH"];
});

test("drops non-allowlisted fields from log output", () => {
  log("info", "test", {
    event: "test_event",
    login: "should-be-dropped",
    outcome: "applied",
  });
  const content = readFileSync(TEST_LOG, "utf8");
  const entry = JSON.parse(content.trim());
  expect(entry.event).toBe("test_event");
  expect(entry.outcome).toBe("applied");
  expect(entry.login).toBeUndefined();
});

test("log function accepts all allowlisted fields", () => {
  expect(() => {
    log("info", "test", {
      event: "webhook",
      action: "opened",
      delivery_id: "abc-123",
      status: 200,
      duration_ms: 42,
      outcome: "applied",
      error_class: "ValidationError",
      repo_id: 12345,
      token_id: "tok_abc",
      reason_code: "stale",
    });
  }).not.toThrow();
});

test("no network sinks in logging module", () => {
  // Verify the module source doesn't import network clients
  const indexPath = join(import.meta.dir as string, "index.ts");
  const source = readFileSync(indexPath, "utf8");
  expect(source).not.toContain("fetch(");
  expect(source).not.toContain("http.request");
  expect(source).not.toContain("net.createConnection");
  expect(source).not.toContain("dgram");
});

test("log output is valid JSONL", () => {
  log("info", "test message", { event: "test" });
  const content = readFileSync(TEST_LOG, "utf8");
  const lines = content.trim().split("\n");
  expect(lines.length).toBe(1);
  const entry = JSON.parse(lines[0] as string);
  expect(entry.ts).toBeDefined();
  expect(entry.level).toBe("info");
  expect(entry.msg).toBe("test message");
  expect(entry.event).toBe("test");
});

test("respects LOG_STDERR environment variable", () => {
  let stderrOutput = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    stderrOutput += chunk;
    return true;
  }) as unknown as typeof process.stderr.write;

  process.env["LOG_STDERR"] = "1";
  log("info", "test", { event: "test" });
  expect(stderrOutput).toContain("test");

  stderrOutput = "";
  delete process.env["LOG_STDERR"];
  log("info", "test2", { event: "test2" });
  expect(stderrOutput).toBe("");

  process.stderr.write = originalWrite;
});
