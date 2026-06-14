# Learnings — github-pr-tracker

## [2026-06-14] Session Start
- Greenfield project — no existing files in /Users/nicolas.thiry/Developer/personal/github-dashboard/
- Turborepo + Bun workspaces monorepo: apps/backend, packages/types
- SQLCipher via better-sqlite3-multiple-ciphers@12.10.0 (pinned exact)
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
