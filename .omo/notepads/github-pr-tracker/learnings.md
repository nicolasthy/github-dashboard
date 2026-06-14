# Learnings — github-pr-tracker

## [2026-06-14] Session Start
- Greenfield project — no existing files in /Users/nicolas.thiry/Developer/personal/github-dashboard/
- Turborepo + Bun workspaces monorepo: apps/backend, packages/types
- SQLCipher via better-sqlite3-multiple-ciphers@12.10.0 (pinned exact) — **see T2 blocker below before relying on this**
- Biome 2.4.13 (pinned exact, no ^ or ~)
- Both servers bind 127.0.0.1 only (8787 webhook, 8788 read API)
- All source paths relative to apps/backend/ unless prefixed
- NO prettier, eslint, husky — Biome + lefthook only
- NO composite:true or project references in tsconfig — Bun resolves @repo/types via workspaces
- verbatimModuleSyntax supersedes isolatedModules:true
- noBarrelFile exception: ONLY packages/types/src/index.ts gets the biome-ignore directive
- SQLCipher open sequence: new Database → pragma key → pragma cipher_compatibility=4 → pragma journal_mode=WAL → pragma foreign_keys=ON → first SELECT 1
- Raw hex key (64 chars), NO KDF/passphrase
- Ghost user id=10137: drop NEW incoming PR events with no existing row
- Ordering fence: drop if existing.updated_at >= payload.updated_at
- Org-level webhook: one secret, one URL, auto-includes new repos; runtime filter narrows to tracked set

## [2026-06-14] T2 spike findings — corrections to prior session start
- **WRONG**: the prior bullet that better-sqlite3-multiple-ciphers loads reliably under Bun N-API on darwin-arm64. Bun 1.3.11 throws `ERR_DLOPEN_FAILED` with `'better-sqlite3' is not yet supported in Bun` on `new Database()`. The binding uses V8 C++ APIs (NODE_MODULE_INIT, node.h), not pure N-API. Tracking: https://github.com/oven-sh/bun/issues/4290.
- **WRONG**: `bun rebuild better-sqlite3-multiple-ciphers` postinstall. `bun rebuild` is not a real Bun subcommand — errors with `Script not found "rebuild"`. The native binding only compiled after manually running `bunx --bun node-gyp rebuild --release` from the package directory.
- **WRONG**: assuming the binding would be prebuilt during `bun install`. No prebuilds exist for `target=node-20 darwin-arm64` from upstream; build-from-source is the only path. Even then, the binary is unloadable under Bun.
- Renaming the .node file to bypass Bun's loader filter does **not** help — Bun segfaults inside the binding's first V8 isolate call. Confirmed locally.
- T2 spike (`apps/backend/bin/spike-sqlcipher.ts`) and `docs/encryption.md` together capture (a) the canonical open sequence we intend to use, and (b) the runtime blocker preventing it. Spike correctly throws and exits non-zero; this is the diagnostic outcome.
