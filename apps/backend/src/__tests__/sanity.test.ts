import { expect, test } from "bun:test";
import {} from "@repo/types";

test("bun test runs", () => {
  expect(1 + 1).toBe(2);
});

test("@repo/types cross-workspace import resolves", () => {
  // If this file compiles, the import resolved
  expect(true).toBe(true);
});

test("PR_TRACKER_KEY env detection does not throw", () => {
  const key = process.env["PR_TRACKER_KEY"];
  expect(key).toBeUndefined();
});
