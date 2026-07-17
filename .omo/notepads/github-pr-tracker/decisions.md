# Decisions — github-pr-tracker

## [2026-06-14] Architecture Decisions (from plan)
- Runtime: Bun (native HTTP, native test runner)
- Monorepo: Turborepo + Bun workspaces
- Webhook ingress: Cloudflare Tunnel → 127.0.0.1:8787/webhook
- Webhook level: org-level (/orgs/{org}/hooks)
- Storage: SQLCipher whole-DB encryption via better-sqlite3-multiple-ciphers@12.10.0
- Read API: HTTP REST on 127.0.0.1:8788, bearer-token auth (argon2id-hashed)
- Repo selection: tracked-repos.yaml at monorepo root, hot-reloaded via fs.watch
- PR lifecycle: both open AND closed stored (closed retained for history)
- Reviews: tracked (pull_request_review events)
- Reconciliation: on every startup via GitHub REST state=all per configured repo
- Test strategy: tests-after with bun test
- Linter/formatter: Biome 2.4.13 (sole tool, no prettier/eslint)
- Pre-commit: lefthook (no husky)
