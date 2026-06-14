import { expect, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrackedRepoConfig } from "./tracked-repos.ts";
import { type WatchHandle, watchTrackedRepos } from "./watcher.ts";

let counter = 0;

function createTempYaml(content: string): string {
  const path = join(tmpdir(), `watcher-test-${Date.now()}-${++counter}.yaml`);
  writeFileSync(path, content, "utf8");
  return path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return false;
}

const VALID_YAML = `org: testorg
repos:
  - repo_id: 1
    owner: testorg
    name: testrepo`;

const UPDATED_YAML = `org: testorg
repos:
  - repo_id: 1
    owner: testorg
    name: testrepo
  - repo_id: 2
    owner: testorg
    name: testrepo2`;

// Valid YAML but fails loadTrackedRepos validation (repos must be a non-empty array)
const INVALID_CONFIG_YAML = `org: testorg
repos: []`;

test("direct write triggers onChange within 2s", async () => {
  const path = createTempYaml(VALID_YAML);
  let callCount = 0;
  let receivedConfig: TrackedRepoConfig | null = null;
  let handle: WatchHandle | null = null;

  try {
    handle = watchTrackedRepos(path, (config) => {
      callCount++;
      receivedConfig = config;
    });

    // Allow watcher to establish
    await sleep(100);

    // Direct write (fires 'change' event — inode preserved)
    writeFileSync(path, UPDATED_YAML, "utf8");

    const fired = await waitFor(() => callCount > 0, 2000);

    expect(fired).toBe(true);
    expect(callCount).toBeGreaterThan(0);
    expect((receivedConfig as TrackedRepoConfig | null)?.repos).toHaveLength(2);
  } finally {
    handle?.stop();
  }
}, 8000);

test("atomic rename triggers onChange within 2s", async () => {
  const path = createTempYaml(VALID_YAML);
  let callCount = 0;
  let handle: WatchHandle | null = null;

  try {
    handle = watchTrackedRepos(path, () => {
      callCount++;
    });

    // Allow watcher to establish
    await sleep(200);

    // Atomic rename (write-to-tmp + mv) — fires 'rename' event on macOS
    // The watcher must re-establish on the new inode (T4 spike §3.2)
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, UPDATED_YAML, "utf8");
    renameSync(tmpPath, path);

    const fired = await waitFor(() => callCount > 0, 2000);

    expect(fired).toBe(true);
    expect(callCount).toBeGreaterThan(0);
  } finally {
    handle?.stop();
  }
}, 8000);

test("invalid config YAML does not call onChange (keeps last-good)", async () => {
  const path = createTempYaml(VALID_YAML);
  let callCount = 0;
  let handle: WatchHandle | null = null;

  try {
    handle = watchTrackedRepos(path, () => {
      callCount++;
    });

    // Allow watcher to establish
    await sleep(100);

    // Write a config that fails loadTrackedRepos validation
    writeFileSync(path, INVALID_CONFIG_YAML, "utf8");

    // Wait longer than debounce (500ms) + generous buffer
    await sleep(1200);

    expect(callCount).toBe(0);
  } finally {
    handle?.stop();
  }
}, 5000);

test("debounce: 5 rapid writes result in at most 2 onChange calls", async () => {
  const path = createTempYaml(VALID_YAML);
  let callCount = 0;
  let handle: WatchHandle | null = null;

  try {
    handle = watchTrackedRepos(path, () => {
      callCount++;
    });

    // Allow watcher to establish
    await sleep(100);

    // 5 rapid synchronous writes — all within a few milliseconds
    for (let i = 0; i < 5; i++) {
      writeFileSync(path, UPDATED_YAML, "utf8");
    }

    // Wait for debounce window (500ms) plus generous buffer
    await sleep(1500);

    // Debounce should coalesce to 1 call; allow 2 for timer imprecision
    expect(callCount).toBeGreaterThan(0);
    expect(callCount).toBeLessThanOrEqual(2);
  } finally {
    handle?.stop();
  }
}, 5000);

test("stop() cancels in-flight debounce and prevents onChange from firing", async () => {
  const path = createTempYaml(VALID_YAML);
  let callCount = 0;

  const handle = watchTrackedRepos(path, () => {
    callCount++;
  });

  // Allow watcher to establish
  await sleep(100);

  // Write triggers a 500ms debounce timer
  writeFileSync(path, UPDATED_YAML, "utf8");

  // Stop synchronously — clears the debounce timer before it fires
  handle.stop();

  // Wait longer than the debounce window
  await sleep(1200);

  expect(callCount).toBe(0);
}, 5000);
