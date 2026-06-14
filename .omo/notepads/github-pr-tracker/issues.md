# Issues — github-pr-tracker

## [2026-06-14] Known Gotchas (from plan)
- exactOptionalPropertyTypes:true may surface friction with Zod v3 inferred types — fix the type, don't disable
- noUndeclaredEnvVars (Biome nursery) requires env vars in turbo.json globalEnv array
- "extends": "//" Biome microsyntax has resolution bugs from subfolders — ALWAYS run bun turbo check from monorepo root
- ~~better-sqlite3-multiple-ciphers@12.10.0 is the ONLY version with reliable Bun N-API loading on darwin-arm64~~ **FALSE** — see P0 blocker below
- PRAGMA key error masquerades as "not a database" — expose custom WrongKeyError
- WAL must be enabled AFTER key pragma, NOT before
- Do NOT rekey under WAL (must switch to DELETE journal mode first)
- ~~postinstall: "bun rebuild better-sqlite3-multiple-ciphers" at workspace level (apps/backend), NOT root~~ **DOES NOT WORK** — see P0 blocker below

## [2026-06-14] P0 BLOCKER (surfaced by T2 spike) — SQLCipher under Bun
- **Symptom**: `bun --filter @repo/backend run spike:sqlcipher` throws `error: 'better-sqlite3' is not yet supported in Bun` with `code: ERR_DLOPEN_FAILED` from `new Database(":memory:")`. Spike exits 1.
- **Root cause**: `better-sqlite3-multiple-ciphers` shares `better_sqlite3.node` with upstream `better-sqlite3`, which is implemented against V8 C++ APIs (NODE_MODULE_INIT, node.h, node_object_wrap.h). Bun's JavaScriptCore runtime does not implement those V8 APIs and its loader defensively blocks the file. Bypassing the filter causes a segfault in `v8::Isolate::Isolate`.
- **Scope**: affects every Bun version (1.1, 1.2, 1.3.x). Not a darwin-arm64 issue — also reproduced on Linux/Docker per upstream bug reports.
- **Secondary**: the `bun rebuild better-sqlite3-multiple-ciphers` postinstall is a silent no-op (`Script not found "rebuild"`). The native binding only compiled by manually invoking `bunx --bun node-gyp rebuild --release` in the package's vendored directory. Even with the binding compiled, Bun refuses to load it.
- **Upstream**: Bun tracks V8 C++ API coverage in oven-sh/bun#4290; SQLCipher in `bun:sqlite` tracked in oven-sh/bun#11397; WiseLibs/better-sqlite3#1353 was closed as "use bun:sqlite".
- **Recovery paths** (each requires re-plan; do not silently pick):
  1. Swap binding → `bun:sqlite` + SQLCipher amalgamation in custom Bun build (blocked on #11397).
  2. Run DB-touching code on Node — either move `@repo/backend` off Bun, or split a Node DB subprocess.
  3. Patch `better-sqlite3-multiple-ciphers` for Bun (working PR exists at rocicorp/zero-sqlite3#13 for upstream `better-sqlite3`).
  4. Defer encryption-at-rest; ship plain `bun:sqlite` + OS disk encryption only.
- **Evidence**: `.omo/evidence/task-2-sqlcipher-spike.txt`; docs: `docs/encryption.md` → "Runtime compatibility (BLOCKER)".
