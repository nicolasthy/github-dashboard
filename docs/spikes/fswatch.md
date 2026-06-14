# T4 — `fs.watch` reliability matrix (macOS)

> **Status:** spike complete. Findings are normative for **T17** (config hot-reload watcher for `tracked-repos.yaml`).
> **Constraint reminder:** no `chokidar`, no polling as primary mechanism. `fs.watch` is the target API.
> **Evidence:** raw JSON event traces are in [`.omo/evidence/task-4-fswatch.log`](../../.omo/evidence/task-4-fswatch.log). Reproduce with `bun apps/backend/bin/spike-fswatch.ts`.

## 1. Why this spike exists

`fs.watch` is convenient but historically lies to you on macOS. Two questions had to be answered before T17 could be implemented:

1. Which `fs.watch` events fire for which write patterns?
2. Does the watcher survive an atomic rename, or does the consumer have to re-establish it?

The answers below are empirical — captured by running `apps/backend/bin/spike-fswatch.ts` against four well-defined write patterns and a recovery-strategy test.

## 2. Environment

| Field | Value |
| --- | --- |
| OS | macOS 26.5 (Darwin 25.5.0, arm64) |
| Runtime | Bun 1.3.11 (mirrors Node `fs.watch` API) |
| Spike script | `apps/backend/bin/spike-fswatch.ts` |
| Fixture | `/tmp/spike-test-watched.yaml` (re-seeded per pattern) |
| Watcher | `fs.watch(path, listener)` — non-recursive, single file |
| Window | 2.5 s per pattern (4 s for the verification run) |

The Bun runtime is Node-compatible for `fs.watch`. On macOS it is backed by FSEvents under the hood, which is why the touch/no-touch asymmetry below shows up.

## 3. Results — write-pattern matrix

| Pattern | Reproducer | Event type | Events for N writes | Watcher survives? |
| --- | --- | --- | --- | --- |
| **A. Direct write** | `echo "x" > file` | `change` | 3 / 3 | yes — inode preserved |
| **B. Atomic rename** | `printf "x" > file.tmp && mv -f file.tmp file` | `rename` | **1 / 2** | **no** — inode swapped |
| **C. Editor save (vim)** | backup `~` + temp + rename (vim `writebackup`) | `rename` | **1 / 2** | **no** — inode swapped |
| **D. `touch`** | `touch file` (also `touch -m -t …`) | _none_ | **0 / 3** | yes, but silent |

### 3.1 Pattern A — direct write (`>` redirect)

```
{"seq":1,"eventType":"change","filename":"watched.yaml"}
{"seq":2,"eventType":"change","filename":"watched.yaml"}
{"seq":3,"eventType":"change","filename":"watched.yaml"}
```

A `>` redirect truncates and rewrites in place. The inode is preserved, so the watcher tracks every subsequent write and emits one `change` per write. **No recovery action is required.** This is the "happy path" for hand-edits done via tools like `nano`, `code` with default settings, or `cat > file`.

### 3.2 Pattern B — atomic rename

```
{"seq":1,"eventType":"rename","filename":"watched.yaml"}
# … then silence …
{"event":"stop","totalEvents":1}
```

Two atomic swaps fired **only one** `rename` event. After the first rename, the new file has a different inode, and the watcher is still bound to the **old** inode. Every subsequent rename is invisible. This is the canonical failure mode the T17 reload loop has to defend against. Mitigation: **close the watcher and re-establish `fs.watch` on the same path** as soon as a `rename` event arrives (see §5).

### 3.3 Pattern C — editor save (vim-style writebackup)

Same observable signature as Pattern B: one `rename`, then silence. Vim's default `writebackup` sequence (`cp file file~`, write to swap, `mv -f swap file`) is functionally identical to an atomic-rename from `fs.watch`'s point of view. Same mitigation.

> **Coverage note.** `vim` with `set nowritebackup set nobackup` writes in place and looks like Pattern A; `vim` with `set backupcopy=yes` also writes in place. The dangerous case is the default, which is what we modelled here.

### 3.4 Pattern D — `touch`

```
{"event":"start", …}
{"event":"stop","totalEvents":0}
```

Zero events. macOS `fs.watch` is **content-driven** — pure metadata updates (`mtime` only, no content change) do not fire any callback. Verified with both `touch file` and `touch -m -t 203012312359 file` over a 4 s window. **T17 cannot use `touch` as a reload trigger**, and operators who want to nudge a reload must rewrite the file.

## 4. Recovery validation — re-watch on `rename`

To confirm the §5 algorithm before T17 builds on it, the spike also ran a recovery test: after every `rename` event, close and re-establish the watcher on the same path.

```
{"seq":1,"eventType":"rename","filename":"watched.yaml"}
{"event":"rewatch"}
{"seq":2,"eventType":"rename","filename":"watched.yaml"}
{"event":"rewatch"}
{"seq":3,"eventType":"rename","filename":"watched.yaml"}
{"event":"rewatch"}
{"event":"stop","totalEvents":3}
```

Three atomic renames → **three** `rename` events captured (vs one in §3.2). The re-watch strategy works.

## 5. Canonical reload algorithm for T17

This is the algorithm T17 (the `tracked-repos.yaml` hot-reload watcher) **must** implement. It is informed by every observation above and is the only configuration of `fs.watch` we have empirically validated as safe on macOS.

```text
WATCH(path, onChange):
  let watcher        = fs.watch(path, handler)
  let lastGoodConfig = parse(read(path))                  // bootstrap
  let pending        = null   // debounce timer
  let reading        = false  // single-flight guard

  function handler(eventType, _filename):
    # Step 1 — RENAME: the inode was swapped under us.
    # Close the dead watcher and re-establish fs.watch on the same path
    # so we track the NEW inode. Then fall through to the change path.
    if eventType == "rename":
      watcher.close()
      watcher = fs.watch(path, handler)                   # re-bind to new inode

    # Step 3 — DEBOUNCE: coalesce bursts within 500 ms.
    # (Editor saves can fire 2–3 events in <50 ms; direct writes can
    # arrive in tight succession. We want at most one read per burst.)
    if pending != null: clearTimeout(pending)
    pending = setTimeout(applyOnce, 500)

  function applyOnce():
    pending = null
    if reading: return                                    # single-flight
    reading = true
    try:
      # Step 2 — CHANGE: read and parse the file.
      let raw    = read(path)
      let parsed = parse(raw)
      lastGoodConfig = parsed
      onChange(parsed)
    catch err:
      # Step 4 — PARSE FAILURE: keep last-good config, do NOT call onChange.
      log.warn("config reload failed; keeping last-good", err)
    finally:
      reading = false
```

### 5.1 Step-by-step rationale

| Step | What it does | Why |
| --- | --- | --- |
| **1. `rename` → re-`watch`** | `watcher.close()` then `fs.watch(path, handler)` again on the same path. | §3.2 and §3.3 — atomic-rename writes swap the inode, the old watcher goes silent, and only a fresh `fs.watch` call sees subsequent renames. Validated in §4. |
| **2. `change` → read + parse** | Read the file synchronously (small YAML), parse it. | `change` only fires for content changes (Pattern A), so reading is safe and meaningful. |
| **3. Debounce 500 ms** | Coalesce events that arrive within a 500 ms window before processing. | Editor saves can emit a `rename` and a `change` back-to-back; tight in-place writes can arrive in <300 ms (see Pattern A). Without debounce, T17 would re-parse and notify subscribers multiple times per logical save. |
| **4. Parse failure → keep last-good** | On parse/IO error: log, retain the previously loaded config, **do not** call `onChange`. | Operators routinely save half-typed YAML. Surfacing partial state to consumers would tear the tracked-repos set. The last-good fallback is the safe default. |

### 5.2 What T17 explicitly does NOT do

- It does NOT add `chokidar` or any 3rd-party watcher.
- It does NOT poll the file on a timer as the primary mechanism. (A long-window safety poll, e.g. once a minute, is acceptable as a belt-and-braces backup but is not part of this spec.)
- It does NOT rely on `touch` to nudge a reload — Pattern D shows it produces zero events.
- It does NOT trust the watcher to survive a `rename` — Patterns B and C show it does not.

### 5.3 Edge cases worth a comment in T17

- **File missing at startup**: open watcher only after first successful read; if the file appears later, T17's bootstrap loop (separate concern) should establish the watcher then.
- **Re-watch race**: if a second `rename` lands between `watcher.close()` and the new `fs.watch(...)` call, it is dropped. The 500 ms debounce + the next inbound event recovers this; the worst case is a one-debounce-window delay, which is acceptable for a config file.
- **ENOENT on re-watch**: if the path is briefly absent (e.g. `rm` then `mv`), re-watch will throw. T17 should catch, schedule a short retry (e.g. 100 ms), and surface persistent failure as a log warning rather than crashing.

## 6. Reproduce

```bash
# One-shot spike against an existing file:
bun apps/backend/bin/spike-fswatch.ts --path=/tmp/spike-test-watched.yaml --duration-ms=5000

# Full matrix (the same driver used to capture the evidence log):
bash /tmp/spike-fswatch/run-patterns.sh   # see .omo/evidence/task-4-fswatch.log
```

The spike script is line-delimited JSON on stdout — pipe to `jq` or grep by `eventType` for ad-hoc analysis.
