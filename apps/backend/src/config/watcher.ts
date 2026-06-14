import { type FSWatcher, watch } from "node:fs";
import { log } from "../logging/index.ts";
import { loadTrackedRepos, type TrackedRepoConfig } from "./tracked-repos.ts";

export type WatchHandle = {
  stop: () => void;
};

export function watchTrackedRepos(
  path: string,
  onChange: (config: TrackedRepoConfig) => void,
): WatchHandle {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function handleEvent(eventType: string): void {
    if (stopped) return;

    // Clear existing debounce timer
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      // On rename, re-establish watcher (new inode from atomic rename / editor save)
      if (eventType === "rename") {
        if (watcher !== null) {
          watcher.close();
          watcher = null;
        }
        // Re-establish watcher after a brief delay to let the file settle
        setTimeout(() => {
          if (!stopped) {
            startWatcher();
          }
        }, 50);
      }

      // Load and validate config
      try {
        const config = loadTrackedRepos(path);
        onChange(config);
      } catch (err: unknown) {
        const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
        log("error", "tracked-repos reload failed", {
          event: "config_reload",
          outcome: "rejected",
          error_class: errorClass,
        });
        // Keep last-good config — do NOT call onChange
      }
    }, 500);
  }

  function startWatcher(): void {
    try {
      watcher = watch(path, { persistent: false }, (eventType) => {
        handleEvent(eventType);
      });

      watcher.on("error", (err: unknown) => {
        const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
        log("error", "fs.watch error", {
          event: "config_watch",
          outcome: "rejected",
          error_class: errorClass,
        });
        // Try to re-establish watcher
        if (watcher !== null) {
          watcher.close();
          watcher = null;
        }
        if (!stopped) {
          setTimeout(startWatcher, 1000);
        }
      });
    } catch (err: unknown) {
      const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
      log("error", "failed to start fs.watch", {
        event: "config_watch",
        outcome: "rejected",
        error_class: errorClass,
      });
    }
  }

  startWatcher();

  return {
    stop(): void {
      stopped = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
