# GitHub PR Tracker — Backend Data Layer

## Review Status

| Gate | Round 1 | Round 2 (scope pivot) | Round 3 (Biome + strict tsconfig) |
|---|---|---|---|
| Metis gap analysis | PASS | n/a | n/a |
| Librarian research | n/a | n/a | Biome 2.x + Turborepo monorepo defaults sourced from biomejs.dev + Turborepo `with-biome` example + Bun TypeScript docs |
| Oracle phase 1 (interview) | GO (5/5 after one fix round) | n/a | n/a (no new interview gaps) |
| Oracle phase 2 (plan compliance) | GO (7/7, first pass) | GO (8/8 after one fix round) | GO (8/8, first pass) |
| Momus | OKAY (iteration 1, 0 fixes) | OKAY (iteration 1, 0 fixes) | OKAY (iteration 1, 0 fixes) |
| Accuracy mode | High | High | High |
| Oracle phase 3 (handoff readiness) | GO (5/5) | GO (5/5 after one fix round) | GO (5/5, first pass) |

## TL;DR

> **Quick Summary**: Build a local, privacy-preserving backend (inside a Turborepo monorepo, `apps/backend`) that ingests GitHub webhooks at the **org level** for a private org, pre-computes the state of **all PRs (open + closed) in a configurable set of repositories**, and serves them via a loopback-only HTTP API. The future web app (separate monorepo workspace) will own the user/author filtering on top of this data. No polling on the read path, no external telemetry, full SQLCipher whole-DB encryption at rest.
>
> **Deliverables**:
> - Turborepo monorepo skeleton (`apps/backend`, `packages/types`) with Bun workspaces
> - Webhook ingestion service (Bun HTTP server on 127.0.0.1:8787, fronted by Cloudflare Tunnel, **org-level webhook**)
> - Encrypted SQLite store via SQLCipher (better-sqlite3-multiple-ciphers@12.10.0)
> - Read API (Bun HTTP server on 127.0.0.1:8788, bearer-token auth, returns open + closed PRs)
> - REST reconciliation service that runs on every startup, per configured repo, `state=all`
> - YAML-driven **tracked-repos** config with hot-reload
> - Shared `packages/types` ready for a future Vercel-hosted web app workspace
> - Bench harness proving inline write path stays under GitHub's 10s timeout
> - Operator runbook (with deferred-deployment decision notes) + admin CLI for tokens
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — 5 implementation waves + 1 final review wave
> **Critical Path**: 1 → 7 → 10 → 13 → 15 → 22 → 23 → F1–F4 → user okay

---

## Context

### Original Request
Design the backend architecture for a real-time GitHub PR tracking system scoped to a private organization. Backend data layer only. TypeScript, local, privacy-preserving. Track PRs in selected org repos via webhooks with pre-computed read state. Author/state filtering deferred to the future web app.

### Post-Plan Amendment (round 2)
After the first plan was approved, the user pivoted on three fronts:
1. **Scope shift**: drop the per-user subset filter. Backend now stores **all PRs (open AND closed) in a configurable set of repositories** owned by the org. Filtering by author/state belongs in the web app.
2. **Monorepo**: this becomes `apps/backend` inside a Turborepo + Bun-workspaces monorepo, with `packages/types` ready to be shared with a future web app workspace.
3. **Vercel hosting**: deferred. The local-first, SQLCipher, loopback architecture is preserved. The runbook adds a "deferred deployment" section documenting the trade-offs (Local-first / Stateful-host / Vercel-rewrite) so the decision tree is captured for later.

### Interview Summary (consolidated)
**Key Decisions**:
- Runtime: **Bun** (native HTTP, native test runner, single-binary packaging path)
- Monorepo: **Turborepo + Bun workspaces**. Backend at `apps/backend`. Shared types at `packages/types`.
- Webhook ingress: **Cloudflare Tunnel** → 127.0.0.1:8787/webhook (no inbound port, free TLS, terminates at loopback)
- Webhook installation level: **org-level** (`/orgs/{org}/hooks`) — one secret, one URL, auto-includes new repos in the org; runtime filter narrows down to the configured repo set.
- Storage: **SQLCipher whole-DB encryption** via `better-sqlite3-multiple-ciphers@12.10.0` (Node-N-API binding loaded by Bun). Raw hex key (no KDF). NO per-row encryption.
- Read API: **HTTP REST bound to 127.0.0.1:8788**, bearer-token auth (argon2id-hashed tokens). Supports `state=open|closed|all`; author filter optional (for the future web app's convenience).
- Repo selection config: **`tracked-repos.yaml`** at the monorepo root, hot-reloaded via `fs.watch`. Lists the repos in the org whose PRs we ingest.
- PR lifecycle stored: **both open and closed**. Closed rows are retained for historical visibility in the future web app.
- Reviews: **Tracked** (subscribe to `pull_request_review`)
- Reconciliation: **On every startup** via GitHub REST `GET /repos/{owner}/{repo}/pulls?state=all` per configured repo (no checkpoint gating)
- Future deployment: **deferred**. Runbook captures Vercel/stateful-host/local trade-offs.
- Test strategy: **tests-after with `bun test`** + mandatory agent-executed QA per task

### Metis Review (preserved across both rounds)
Metis identified and locked the following constraints (all incorporated below). Items marked **[amended]** were re-scoped after the round-2 pivot.
- Webhook event allowlist: exactly 4 events (`pull_request`, `pull_request_review`, `repository`, `ping`) with named actions only.
- Ordering fence: drop any update where `payload.pull_request.updated_at < stored.updated_at`.
- Ghost user (id `10137`) **[amended]**: the config-level rejection is no longer needed (we no longer list users in config). The runtime guard remains: drop NEW incoming PR events whose `payload.pull_request.user.id === 10137` AND no existing PR row, since they cannot be attributed.
- Canonical FKs: `user.id` (numeric) everywhere; `login` denormalized into a `person` table for web-app display.
- Canonical repo identity: `repo_id` (numeric); handle `repository.renamed` to update denormalized name.
- SQLCipher binding pinned to `better-sqlite3-multiple-ciphers@12.10.0`; banned `@journeyapps/sqlcipher` and `bun:sqlite` dylib swap.
- Open sequence: `new Database` → `pragma("key=x'...'")` → `pragma("cipher_compatibility=4")` → `pragma("journal_mode=WAL")` → first read. Use raw hex key (no KDF).
- 10s GitHub webhook timeout: inline SQLCipher write path must measure p99 < 500ms; fallback to "respond 202, persist async" only if bench fails.
- No programmatic GitHub redelivery API usage in v1.
- Merge-queue actions (`enqueued`/`dequeued`): log and ignore.
- **[amended]** Org-level webhook means we receive events for ALL repos in the org. A repo-allowlist check in the handler drops events for repos absent from `tracked-repos.yaml` (outcome: `'ignored'`).

---

## Work Objectives

### Core Objective
Stand up a local, single-process backend (inside a Turborepo + Bun-workspaces monorepo at `apps/backend`) that ingests GitHub webhooks at the **org level** and exposes **all PRs (open and closed) in a configurable set of repositories** over a loopback HTTP API — pre-computed, encrypted at rest, with zero external telemetry. Author/state filtering is the future web app's concern.

### Path Convention (monorepo)
All source paths below are **relative to `apps/backend/`** unless explicitly prefixed with `packages/types/` or rooted at the monorepo top-level (e.g. `tracked-repos.yaml`, `turbo.json`, root `package.json`).

### Concrete Deliverables
- Monorepo root: `package.json` (Bun workspaces), `turbo.json`, `.bun-version`, `bunfig.toml`, `tracked-repos.yaml` (template), `.env.local.example`
- `packages/types/src/index.ts` — shared TypeScript types (domain + webhook payload narrowed types) consumable by future `apps/web`
- `apps/backend/src/server/webhook.ts` — HTTP server on 127.0.0.1:8787 with `/webhook` and `/ping` routes
- `apps/backend/src/server/read-api.ts` — HTTP server on 127.0.0.1:8788 with `/api/health`, `/api/prs`, `/api/prs/:id`, `/api/repos`
- `apps/backend/src/db/connection.ts` — SQLCipher-aware connector with raw-hex-key open sequence
- `apps/backend/src/db/migrations/` — SQL schema files for 8 tables (see T5)
- `apps/backend/src/handlers/pull-request.ts`, `pull-request-review.ts`, `repository.ts`
- `apps/backend/src/github/client.ts` — Octokit-based REST client for reconciliation only
- `apps/backend/src/reconcile/index.ts` — on-startup REST reconciliation service (per configured repo, `state=all`)
- `apps/backend/src/config/tracked-repos.ts` — YAML loader + DB sync
- `apps/backend/src/config/watcher.ts` — `fs.watch`-based hot-reloader for `tracked-repos.yaml`
- `apps/backend/src/auth/token-store.ts` + `apps/backend/bin/token` CLI — argon2id token generation and verification
- `apps/backend/src/logging/index.ts` — allowlist field logger, file sink only
- `apps/backend/src/index.ts` — process entrypoint with signal handling
- `apps/backend/bin/bench-webhook.ts` — bench harness validating inline write-path p99 < 500ms
- `docs/runbook.md` — operator runbook (start, stop, rotate keys, rotate tokens, rotate webhook secret, **deferred-deployment trade-offs**)
- `docs/encryption.md` — SQLCipher open sequence + rekey runbook

### Definition of Done
- [ ] `bun turbo typecheck` passes across all workspaces with the full strict cluster active
- [ ] `bun turbo check` (Biome) reports zero errors and zero warnings
- [ ] `bun turbo test` passes (all suites green)
- [ ] `bun --filter @repo/backend run bench:webhook` reports p99 < 500ms over 1000 simulated `pull_request.synchronize` events
- [ ] `bunx biome --version` reports exactly `2.4.13` (no `^`/`~` drift)
- [ ] `curl -H "Authorization: Bearer <token>" http://127.0.0.1:8788/api/prs?state=open` returns JSON within 50ms
- [ ] `curl -H "Authorization: Bearer <token>" http://127.0.0.1:8788/api/prs?state=closed` returns closed PRs (proving closed lifecycle is stored)
- [ ] `curl -H "Authorization: Bearer <token>" http://127.0.0.1:8788/api/prs?state=all&author=<id>` returns author-filtered union
- [ ] `curl http://0.0.0.0:8787/webhook` is refused (binding check)
- [ ] `curl http://0.0.0.0:8788/api/prs` is refused (binding check)
- [ ] SQLCipher DB is unreadable without key: `sqlite3 apps/backend/data/prs.db ".tables"` returns "file is not a database"
- [ ] Reconciliation on cold start aligns DB state with GitHub for every configured repo (`state=all`)
- [ ] An event arriving for a repo NOT in `tracked-repos.yaml` is logged as `outcome=ignored` with zero DB writes
- [ ] `tracked-repos.yaml` mutations are reflected within 2s without restart
- [ ] No external network endpoints in logs/metrics output (verified via packet capture during test run)
- [ ] `packages/types` is importable from a sibling workspace (`apps/web` placeholder import test)
- [ ] No `prettier`, `eslint`, or `husky` in the dep tree
- [ ] `// biome-ignore` directives count = 1 (only the sanctioned barrel-file directive in `packages/types/src/index.ts`)

### Must Have
- HMAC-SHA256 verification of `X-Hub-Signature-256` with constant-time compare (`Bun.timingSafeEqual` or `crypto.timingSafeEqual`)
- `X-GitHub-Delivery` idempotency dedup via `delivery_log` table
- Org allowlist check on `repository.owner.login` (must match configured org)
- **Repo allowlist check**: drop events for repos not in `tracked-repos.yaml` (`outcome='ignored'`)
- Ordering fence: stored `updated_at` ≥ payload `updated_at` ⇒ drop
- Ghost user (id `10137`) runtime guard: drop new incoming PR events with this author id when no row exists
- Reconciliation on every startup for every configured repo, **`state=all`** (open + closed)
- Both servers bound to 127.0.0.1 only
- Bearer tokens stored as argon2id hashes
- SQLCipher raw hex key (32 bytes), key from macOS Keychain (preferred) or `.env.local` (fallback)
- Allowlist logger: only `{event, action, delivery_id, status, duration_ms, outcome, error_class, repo_id, token_id, reason_code}` — no payload, no login, no title
- Webhook handler responds within 10s; bench proves p99 < 500ms
- Monorepo: Bun workspaces + Turborepo; `packages/types` importable from a sibling workspace
- **Biome 2.4.13 (pinned exact)** as the sole linter+formatter with `"recommended": false` + enumerated rules including `noExplicitAny`, `noNonNullAssertion`, `noConsole`, `noFloatingPromises`, `useAwait`, `noBarrelFile`, `noReExportAll`, `useImportType`, `noUndeclaredEnvVars`
- **Strict `tsconfig.base.json`** with the full 11-flag cluster (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `allowUnreachableCode: false`, `allowUnusedLabels: false`) plus `verbatimModuleSyntax`, `moduleResolution: bundler`, `module: Preserve`, `target: ESNext`, `lib: ["ESNext"]`
- **Lefthook** pre-commit hook running `bun turbo check && bun turbo typecheck`

### Must NOT Have (Guardrails)
- **No polling of GitHub on the read path** (reconciliation is startup-only)
- **No external telemetry** (Sentry, OTLP, Datadog, posthog — banned)
- **No public-facing port** (no `0.0.0.0` bind anywhere)
- **No per-row AES-GCM encryption** (SQLCipher whole-DB only — split-key complexity rejected)
- **No `@journeyapps/sqlcipher`** (broken under Bun)
- **No `bun:sqlite` with dylib swap** (undocumented and fragile)
- **No storage of**: PR body, file diffs, commit messages, comment bodies, branch names (head SHA stored as opaque, no ref name)
- **No `pull_request_review_comment` subscription** (out of scope)
- **No `issue_comment` subscription** (out of scope)
- **No `pull_request` actions beyond the 7 locked** (no labeled/unlabeled/assigned/etc.)
- **No KDF on SQLCipher key** (raw hex key only — bypass PBKDF2)
- **No programmatic use of GitHub redelivery API** (v2 concern)
- **No tracking of merge-queue state** (`enqueued`/`dequeued` logged and ignored)
- **No logins or PR titles in logs** ever, even at debug
- **No CLI or HTTP path that exposes the SQLCipher key**
- **No multi-process readers** (single Bun process)
- **No web UI, HTML rendering, or web app code in `apps/backend/`** (read API serves JSON only; future web app is a separate workspace)
- **No PR transfer logic** (PRs cannot transfer between repos in GitHub)
- **No user/author subset config in v1** (filtering belongs in the future web app)
- **No deployment-target-specific code** (no Vercel-only or Node-runtime-only paths — the local Bun build is the only build; deployment is deferred)
- **No `prettier`, `eslint`, or any plugin thereof** (Biome is the sole linter+formatter)
- **No `husky`** (lefthook is the locked pre-commit hook manager)
- **No `"recommended": true`** in `biome.json` (rules are enumerated for stability + auditability)
- **No range specifiers** (`^`, `~`) on `@biomejs/biome` (exact pin only)
- **No `composite: true`** or project references in any tsconfig (Bun workspace resolution handles `@repo/types` directly)
- **No `// biome-ignore`** anywhere except the single sanctioned `noBarrelFile` directive in `packages/types/src/index.ts`
- **No `target: ES2023`, `lib: ["DOM"]`, or `moduleResolution: nodenext`** (Bun-only backend uses `ESNext` / `bundler`)
- **No per-workspace `biome.json`** unless an explicit override is required (none at scaffolding; would be added only with documented rationale)
- **No `isolatedModules: true`** (`verbatimModuleSyntax` supersedes it)

### Spec Framework Integration
No SDD framework detected (no `openspec/`, no `.specify/`). Section omitted.

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — all verification is agent-executed.
> Acceptance criteria requiring "user manually tests" are FORBIDDEN.

### Test Decision
- **Infrastructure exists**: NO (greenfield)
- **Automated tests**: YES (tests-after)
- **Framework**: `bun test` (built-in)
- **Setup task**: Wave 1 scaffolding includes bun test config + first sanity test

### QA Policy
Every task includes agent-executed QA scenarios. Evidence saved to `.omo/evidence/task-{N}-{slug}.{ext}`.
- **Webhook/API endpoints**: Bash + curl (assert status, headers, body fields)
- **DB state**: Bash + `sqlite3` (with `PRAGMA key`) or direct module exec via `bun -e`
- **Process behavior**: `interactive_bash` (tmux) for signal handling, hot-reload, startup logs
- **No UI**: Playwright not used in this plan

### Verification Commands
```bash
# From monorepo root unless noted
bun install                                                # install + postinstall rebuild + lefthook install
bun turbo typecheck                                        # strict tsconfig across all workspaces
bun turbo check                                            # Biome lint + format check (zero warnings tolerated)
bun turbo test                                             # run all workspace tests
bun --filter @repo/backend run bench:webhook               # p99 latency under threshold
bun --filter @repo/backend run start                       # boots both servers, runs reconciliation
curl -sv http://127.0.0.1:8788/api/health                  # read API liveness
curl -sv http://0.0.0.0:8787/webhook                       # MUST be refused (binding check)
lsof -iTCP -sTCP:LISTEN -P -n | grep -E '8787|8788'        # MUST show 127.0.0.1 only
sqlite3 apps/backend/data/prs.db ".tables"                 # MUST report "file is not a database"
bun -e 'import { PullRequest } from "@repo/types"'         # MUST resolve (cross-workspace import)
bunx biome --version                                       # MUST print exactly "2.4.13"
```

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 — Foundation & Spikes (parallel, 7):
├── 1.  Monorepo scaffolding (Turborepo + Bun workspaces) + tsconfig     [quick]
├── 2.  SQLCipher-under-Bun smoke spike                                  [deep]
├── 3.  Cloudflared resilience spike (90s outage delivery loss count)    [deep]
├── 4.  fs.watch on macOS reliability spike                              [deep]
├── 5.  SQL schema + migrations runner                                   [unspecified-high]
├── 6.  Shared types package (packages/types)                            [quick]
└── 7.  Encrypted DB connector module                                    [unspecified-high]

Wave 2 — Webhook Ingest (parallel, 6):
├── 8.  HMAC signature verifier                                          [quick]
├── 9.  Delivery dedup store                                             [quick]
├── 10. pull_request handler (7 actions + repo allowlist + fence + ghost guard)  [deep]
├── 11. pull_request_review handler (3 actions)                          [unspecified-high]
├── 12. repository.renamed handler                                       [quick]
└── 13. Webhook HTTP server (binds 127.0.0.1:8787)                       [unspecified-high]

Wave 3 — REST Reconciliation & Config (parallel, 4):
├── 14. Octokit REST client (rate-limit aware, ephemeral PAT)            [unspecified-high]
├── 15. Reconciliation service (per configured repo, state=all)          [deep]
├── 16. tracked-repos.yaml loader + DB sync                              [quick]
└── 17. Config hot-reload watcher (fs.watch on tracked-repos.yaml)       [unspecified-high]

Wave 4 — Read API & Security (parallel, 5):
├── 18. Argon2id token store + bin/token CLI                             [unspecified-high]
├── 19. Auth middleware                                                  [quick]
├── 20. Read API HTTP server (4 routes, binds 127.0.0.1:8788)            [unspecified-high]
├── 21. Privacy-allowlist logger (file sink only)                        [quick]
└── 22. Process entrypoint + signal handling                             [unspecified-high]

Wave 5 — Quality Gates & Ops (parallel, 3):
├── 23. Inline write-path bench (p99 < 500ms)                            [deep]
├── 24. CI smoke test for SQLCipher binding under Bun                    [unspecified-high]
└── 25. Operator runbook + README quickstart                             [writing]

Final Wave — Reviews (4 parallel) → user okay:
├── F1. Plan compliance audit                                            [oracle]
├── F2. Code quality review                                              [unspecified-high]
├── F3. Real manual QA                                                   [unspecified-high]
└── F4. Scope fidelity check                                             [deep]

Critical Path: 1 → 7 → 10 → 13 → 15 → 22 → 23 → F1–F4 → user okay
Max Concurrent: 7 (Wave 1)
```

### Dependency Matrix

- **1**: blocks 2-25 (all subsequent tasks need scaffolding)
- **2**: depends 1 — blocks 7, 23, 24
- **3**: depends 1 — blocks 22 (informs entrypoint + ops)
- **4**: depends 1 — blocks 17
- **5**: depends 1, 6 — blocks 7, 10, 11, 12, 15
- **6**: depends 1 — blocks 5, 7, 10–17, 18–20
- **7**: depends 1, 2, 5, 6 — blocks 10–12, 15, 18, 20
- **8**: depends 1, 6 — blocks 13
- **9**: depends 1, 5, 7 — blocks 13
- **10**: depends 5, 7 — blocks 13, 15, 23
- **11**: depends 5, 7 — blocks 13
- **12**: depends 5, 7 — blocks 13
- **13**: depends 7, 8, 9, 10, 11, 12 — blocks 22, 23
- **14**: depends 6 — blocks 15
- **15**: depends 5, 7, 10, 14, 16 — blocks 22
- **16**: depends 5, 6, 7 — blocks 15, 17, 22
- **17**: depends 16, 4 — blocks 22
- **18**: depends 6, 7 — blocks 19, 22
- **19**: depends 18 — blocks 20
- **20**: depends 7, 19, 21 — blocks 22
- **21**: depends 1 — blocks 13, 20, 22
- **22**: depends 13, 15, 17, 20, 21, 3 — blocks 23, 25, F1-F4
- **23**: depends 22, 10, 13 — blocks F1, F2
- **24**: depends 2, 7 — blocks F2
- **25**: depends 22 — blocks F1

### Agent Dispatch Summary
- **Wave 1 (7)**: T1 → `quick`, T2-T4 → `deep`, T5,T7 → `unspecified-high`, T6 → `quick`
- **Wave 2 (6)**: T8,T9,T12 → `quick`, T10 → `deep`, T11,T13 → `unspecified-high`
- **Wave 3 (4)**: T14,T17 → `unspecified-high`, T15 → `deep`, T16 → `quick`
- **Wave 4 (5)**: T18,T20,T22 → `unspecified-high`, T19,T21 → `quick`
- **Wave 5 (3)**: T23 → `deep`, T24 → `unspecified-high`, T25 → `writing`
- **Final (4)**: F1 → `oracle`, F2,F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Monorepo scaffolding (Turborepo + Bun workspaces) + Biome + strict tsconfig + lefthook

  **What to do**:

  **A. Monorepo root files (verbatim contents below)**

  - Root `package.json`:
    ```json
    {
      "private": true,
      "name": "github-dashboard",
      "type": "module",
      "workspaces": ["apps/*", "packages/*"],
      "packageManager": "bun@<pinned-from-.bun-version>",
      "engines": { "bun": ">=1.2.0" },
      "scripts": {
        "build": "bun turbo build",
        "test": "bun turbo test",
        "typecheck": "bun turbo typecheck",
        "lint": "biome lint .",
        "format": "biome format . --write",
        "check": "biome check .",
        "check:fix": "biome check . --write",
        "prepare": "lefthook install"
      },
      "devDependencies": {
        "@biomejs/biome": "2.4.13",
        "lefthook": "1.x",
        "turbo": "2.x",
        "typescript": "5.x"
      }
    }
    ```
    Pin `@biomejs/biome` to an **exact** version (no `^`) — nursery rules can change signatures between minor versions.

  - Root `turbo.json` (root tasks for Biome per Turborepo's official Biome guide):
    ```jsonc
    {
      "$schema": "https://turborepo.dev/schema.json",
      "tasks": {
        "build": {
          "dependsOn": ["^build"],
          "inputs": ["$TURBO_DEFAULT$", ".env*"],
          "outputs": ["dist/**"]
        },
        "test": {
          "dependsOn": ["^build"],
          "inputs": ["$TURBO_DEFAULT$"]
        },
        "typecheck": {
          "dependsOn": ["^typecheck"],
          "inputs": ["$TURBO_DEFAULT$", "tsconfig*.json"]
        },
        "//#lint": {
          "inputs": ["$TURBO_DEFAULT$", "biome.json"]
        },
        "//#check": {
          "inputs": ["$TURBO_DEFAULT$", "biome.json"]
        },
        "//#format": { "cache": false }
      }
    }
    ```

  - Root `biome.json` (full config — see "B. Biome ruleset" below for the body).

  - Root `tsconfig.base.json` (strict cluster — see "C. tsconfig.base.json" below).

  - Root `lefthook.yml`:
    ```yaml
    pre-commit:
      parallel: false
      commands:
        biome-check:
          glob: "*.{ts,tsx,js,jsx,json,jsonc}"
          run: bun turbo check
          stage_fixed: true
        typecheck:
          glob: "*.{ts,tsx}"
          run: bun turbo typecheck
    ```

  - Root `.bun-version` (exact Bun version, e.g. `1.2.20`).
  - Root `bunfig.toml`:
    ```toml
    [install]
    auto = false
    ```
  - Root `.gitignore`: `node_modules/`, `.turbo/`, `dist/`, `coverage/`, `apps/*/data/`, `apps/*/logs/`, `.env.local`, `*.db`, `*.db-journal`, `*.db-wal`, `*.db-shm`.
  - Root `tracked-repos.yaml` (template per T16 schema, with a commented example block).
  - Root `.env.local.example` with placeholder keys: `PR_TRACKER_KEY=`, `GITHUB_WEBHOOK_SECRET=`, `GITHUB_RECONCILE_TOKEN=`, `GITHUB_ORG=`.
  - Root `docs/.gitkeep`, `.omo/evidence/.gitkeep`.

  **B. Biome ruleset (root `biome.json`)**

  ```jsonc
  {
    "$schema": "https://biomejs.dev/schemas/2.4.13/schema.json",
    "vcs": {
      "enabled": true,
      "clientKind": "git",
      "useIgnoreFile": true
    },
    "files": {
      "ignoreUnknown": true,
      "includes": [
        "**",
        "!**/node_modules",
        "!**/dist",
        "!**/.turbo",
        "!**/build",
        "!**/coverage",
        "!**/*.generated.*",
        "!**/data",
        "!**/logs"
      ]
    },
    "formatter": {
      "enabled": true,
      "indentStyle": "space",
      "indentWidth": 2,
      "lineWidth": 100,
      "lineEnding": "lf"
    },
    "javascript": {
      "formatter": {
        "quoteStyle": "double",
        "semicolons": "always",
        "trailingCommas": "all",
        "arrowParentheses": "always",
        "bracketSpacing": true,
        "bracketSameLine": false
      }
    },
    "linter": {
      "enabled": true,
      "rules": {
        "recommended": false,
        "correctness": {
          "noConstAssign": "error", "noConstantCondition": "error",
          "noEmptyCharacterClassInRegex": "error", "noEmptyPattern": "error",
          "noGlobalObjectCalls": "error", "noInvalidBuiltinInstantiation": "error",
          "noInvalidConstructorSuper": "error", "noNonoctalDecimalEscape": "error",
          "noPrecisionLoss": "error", "noSelfAssign": "error", "noSetterReturn": "error",
          "noSwitchDeclarations": "error", "noUndeclaredVariables": "error",
          "noUnreachable": "error", "noUnreachableSuper": "error",
          "noUnsafeFinally": "error", "noUnsafeOptionalChaining": "error",
          "noUnusedLabels": "error", "noUnusedPrivateClassMembers": "error",
          "noUnusedVariables": "error", "useIsNan": "error",
          "useValidForDirection": "error", "useValidTypeof": "error", "useYield": "error"
        },
        "suspicious": {
          "noAsyncPromiseExecutor": "error", "noCatchAssign": "error",
          "noClassAssign": "error", "noCompareNegZero": "error",
          "noConsole": "error",
          "noConstantBinaryExpressions": "error", "noControlCharactersInRegex": "error",
          "noDebugger": "error", "noDuplicateCase": "error",
          "noDuplicateClassMembers": "error", "noDuplicateElseIf": "error",
          "noDuplicateObjectKeys": "error", "noDuplicateParameters": "error",
          "noEmptyBlockStatements": "error", "noExplicitAny": "error",
          "noExtraNonNullAssertion": "error", "noFallthroughSwitchClause": "error",
          "noFunctionAssign": "error", "noGlobalAssign": "error",
          "noImportAssign": "error", "noIrregularWhitespace": "error",
          "noMisleadingCharacterClass": "error", "noMisleadingInstantiator": "error",
          "noNonNullAssertedOptionalChain": "error", "noPrototypeBuiltins": "error",
          "noRedeclare": "error", "noShadowRestrictedNames": "error",
          "noSparseArray": "error", "noUnsafeDeclarationMerging": "error",
          "noUnsafeNegation": "error", "noUselessRegexBackrefs": "error",
          "noWith": "error", "useGetterReturn": "error",
          "useNamespaceKeyword": "error", "useAwait": "error"
        },
        "complexity": {
          "noAdjacentSpacesInRegex": "error", "noExtraBooleanCast": "error",
          "noUselessCatch": "error", "noUselessEscapeInRegex": "error",
          "noUselessTypeConstraint": "error"
        },
        "style": {
          "noCommonJs": "error", "noNamespace": "error",
          "useArrayLiterals": "error", "useAsConstAssertion": "error",
          "useConst": "error", "noNonNullAssertion": "error",
          "useImportType": "error", "noExportedImports": "error"
        },
        "security": {
          "noDangerouslySetInnerHtml": "error"
        },
        "performance": {
          "noBarrelFile": "error", "noReExportAll": "error"
        },
        "nursery": {
          "noFloatingPromises": "error", "useAwaitThenable": "error",
          "noUndeclaredEnvVars": "error"
        }
      }
    },
    "assist": {
      "enabled": true,
      "actions": { "source": { "organizeImports": "on" } }
    }
  }
  ```

  **C. `tsconfig.base.json` (root)**

  ```jsonc
  {
    "$schema": "https://json.schemastore.org/tsconfig",
    "compilerOptions": {
      "target": "ESNext",
      "lib": ["ESNext"],
      "module": "Preserve",
      "moduleResolution": "bundler",
      "moduleDetection": "force",
      "verbatimModuleSyntax": true,
      "resolveJsonModule": true,
      "allowImportingTsExtensions": true,
      "noEmit": true,
      "skipLibCheck": true,
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "noImplicitOverride": true,
      "noImplicitReturns": true,
      "noFallthroughCasesInSwitch": true,
      "forceConsistentCasingInFileNames": true,
      "exactOptionalPropertyTypes": true,
      "noPropertyAccessFromIndexSignature": true,
      "useUnknownInCatchVariables": true,
      "allowUnreachableCode": false,
      "allowUnusedLabels": false,
      "noUnusedLocals": false,
      "noUnusedParameters": false
    }
  }
  ```
  > **Rationale for `noUnusedLocals/Parameters: false`**: Biome's `noUnusedVariables` handles this with a cleaner escape hatch (`// biome-ignore`). TS errors here are harder to suppress per-line.

  **D. Workspace packages**

  - `packages/types/`:
    - `package.json`:
      ```json
      {
        "name": "@repo/types",
        "private": true,
        "type": "module",
        "exports": { ".": "./src/index.ts" },
        "scripts": {
          "typecheck": "tsc --noEmit"
        },
        "devDependencies": { "typescript": "5.x" }
      }
      ```
    - `tsconfig.json`:
      ```json
      {
        "extends": "../../tsconfig.base.json",
        "compilerOptions": { "rootDir": "src" },
        "include": ["src/**/*"]
      }
      ```
    - `src/index.ts` placeholder export so the workspace resolves: `export {};` (real types added in T6).
    - **NO `biome.json`** at this workspace — inherits root.

  - `apps/backend/`:
    - `package.json`:
      ```json
      {
        "name": "@repo/backend",
        "private": true,
        "type": "module",
        "scripts": {
          "start": "bun src/index.ts",
          "test": "bun test",
          "typecheck": "tsc --noEmit",
          "bench:webhook": "bun bin/bench-webhook.ts",
          "migrate": "bun src/db/migrate.ts",
          "token": "bun bin/token.ts"
        },
        "dependencies": {
          "@octokit/rest": "21.x",
          "@repo/types": "workspace:*",
          "argon2": "0.x",
          "better-sqlite3-multiple-ciphers": "12.10.0",
          "yaml": "2.x"
        },
        "devDependencies": {
          "@types/bun": "latest",
          "typescript": "5.x"
        }
      }
      ```
    - `postinstall: "bun rebuild better-sqlite3-multiple-ciphers"` at workspace level (NOT root) so it only rebuilds for the workspace that needs it.
    - `tsconfig.json`:
      ```json
      {
        "extends": "../../tsconfig.base.json",
        "compilerOptions": { "types": ["bun-types"], "rootDir": "." },
        "include": ["src/**/*", "bin/**/*"]
      }
      ```
    - Directory skeleton: `src/{server,db,handlers,github,reconcile,config,auth,logging}/`, `src/db/migrations/`, `bin/`, `data/.gitkeep`, `logs/.gitkeep`.
    - One sanity test `src/__tests__/sanity.test.ts` that:
      1. Asserts `bun test` runs.
      2. Imports a symbol from `@repo/types` to prove cross-workspace resolution.
      3. Asserts `process.env.PR_TRACKER_KEY === undefined` is detected without throwing (proves `verbatimModuleSyntax` import discipline holds).
    - **NO `biome.json`** at this workspace — inherits root.

  **Must NOT do**:
  - Do NOT install `@journeyapps/sqlcipher`, `bun:sqlite` (for the encrypted DB), `dotenv` (Bun loads `.env.local` natively), Sentry, OTLP, posthog, or any telemetry SDK.
  - Do NOT add a web framework (Express/Hono/Fastify) — use `Bun.serve` directly.
  - Do NOT add `prettier`, `eslint`, or any plugin thereof — Biome is the sole linter+formatter.
  - Do NOT install `husky` — `lefthook` is the locked pre-commit hook manager.
  - Do NOT enable `"recommended": true` in `biome.json` — rules are explicitly enumerated for auditability.
  - Do NOT use range specifiers (`^`, `~`) for `@biomejs/biome` — pin exact version.
  - Do NOT add `composite: true` or project references to any tsconfig — Bun resolves `@repo/types` via workspaces directly.
  - Do NOT create per-workspace `biome.json` files unless an override is required (none are required at scaffolding time).
  - Do NOT add `target: ES2023`, `lib: ["DOM"]`, or `moduleResolution: nodenext` — Bun-only backend uses `ESNext`/`bundler`.
  - Do NOT create an `apps/web/` placeholder yet — out of scope for this plan.
  - Do NOT add deployment configs (`vercel.json`, `fly.toml`, etc.) — deferred.

  **Caveats (record in `docs/conventions.md`)**:
  - `exactOptionalPropertyTypes: true` may surface friction with Zod v3 inferred types. If hit in later tasks, prefer fixing the type rather than disabling — escape via workspace tsconfig override only as last resort.
  - `noUndeclaredEnvVars` (Biome nursery) requires env vars in `turbo.json`'s `globalEnv`. Add `PR_TRACKER_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_RECONCILE_TOKEN`, `GITHUB_ORG`, `TRACKED_REPOS_PATH`, `PR_TRACKER_DB`, `LOG_STDERR` to `turbo.json` `globalEnv` array.
  - `"extends": "//"` Biome microsyntax has known resolution bugs when invoked from inside a subfolder; ALWAYS run `bun turbo check` from monorepo root, never `cd apps/backend && biome check .`.

  **Recommended Agent Profile**:
  - **Category**: `quick` — mechanical scaffolding, but with many concrete files. No design decisions remain.
  - **Skills**: none required.

  **Parallelization**:
  - **Can Run In Parallel**: NO (foundation for everything)
  - **Blocks**: 2-25
  - **Blocked By**: None

  **References**:
  - Bun docs: `https://bun.sh/docs/runtime/env` — `.env.local` is auto-loaded.
  - Bun TypeScript: `https://bun.com/docs/typescript` — confirms `moduleResolution: bundler`, `module: Preserve`, `target/lib: ESNext`.
  - Turborepo + Bun: `https://turborepo.com/docs/guides/tools/bun`.
  - Turborepo + Biome: `https://turborepo.dev/docs/guides/tools/biome` — root-task pattern, `$TURBO_DEFAULT$` inputs.
  - Biome big-projects guide: `https://biomejs.dev/guides/big-projects/` — `"extends": "//"` monorepo pattern, Biome 2.x workspace inheritance.
  - Biome config reference: `https://biomejs.dev/reference/configuration/` — full rule catalogue.
  - Vercel Turborepo `with-biome` example: `https://github.com/vercel/turborepo/tree/main/examples/with-biome` — canonical `biome.json` with `"recommended": false` + enumerated rules.
  - `ilbertt/bun-monorepo-starter`: Bun + Turborepo + Biome 2.4.13 reference combo.
  - Matt Pocock TSConfig cheat sheet: `https://www.totaltypescript.com/tsconfig-cheat-sheet` — strict cluster justification.
  - Pinning rationale: Metis confirmed `better-sqlite3-multiple-ciphers@12.10.0` is the only version with reliable Bun N-API loading on darwin-arm64; older versions hit ABI mismatches.

  **Acceptance Criteria**:
  - [ ] `bun install` from monorepo root succeeds; `apps/backend/node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node` exists (or hoisted equivalent).
  - [ ] `bun turbo test` runs the sanity test inside `apps/backend` and reports `1 pass`.
  - [ ] `bun turbo typecheck` reports zero errors across both workspaces with the strict cluster (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` all active).
  - [ ] `bun turbo check` (Biome lint + format check) reports zero errors and zero warnings.
  - [ ] `bun turbo lint` reports zero errors.
  - [ ] `biome --version` reports exactly `2.4.13` (pinned, no `^`).
  - [ ] `ls apps/backend/src/` shows the 8 module directories; `ls packages/types/src/` shows `index.ts`.
  - [ ] Sanity test imports a symbol from `@repo/types` to prove cross-workspace resolution works.
  - [ ] `lefthook install` succeeded and `.git/hooks/pre-commit` exists.
  - [ ] `turbo.json` `globalEnv` lists all 7 env vars (`PR_TRACKER_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_RECONCILE_TOKEN`, `GITHUB_ORG`, `TRACKED_REPOS_PATH`, `PR_TRACKER_DB`, `LOG_STDERR`).
  - [ ] No `prettier`, `eslint`, or `husky` packages anywhere in the dep tree.

  **QA Scenarios**:
  ```
  Scenario: Fresh clone bootstraps cleanly
    Tool: Bash
    Preconditions: rm -rf node_modules apps/*/node_modules apps/*/data/*.db apps/*/logs/*.log
    Steps:
      1. bun install
      2. bun turbo test
      3. bun turbo typecheck
      4. bun turbo check
    Expected Result: install exit=0; test "1 pass 0 fail" in apps/backend; typecheck exit 0 across workspaces; check exit 0
    Failure Indicators: ABI error from better-sqlite3-multiple-ciphers, missing native binding, @repo/types unresolved, biome lint/format violations
    Evidence: .omo/evidence/task-1-bootstrap.txt

  Scenario: Biome version pinned exactly
    Tool: Bash
    Preconditions: bun install complete
    Steps:
      1. jq -r '.devDependencies["@biomejs/biome"]' package.json
      2. bunx biome --version
    Expected Result: step 1 prints "2.4.13" (no ^ or ~); step 2 prints "Version: 2.4.13"
    Evidence: .omo/evidence/task-1-biome-pin.txt

  Scenario: Biome catches forbidden patterns
    Tool: Bash
    Preconditions: scaffolding committed
    Steps:
      1. cat > /tmp/biome-probe.ts <<'EOF'
         const x: any = 1;
         console.log(x);
         async function f() { return 1; }
         f();
         EOF
      2. cp /tmp/biome-probe.ts apps/backend/src/__tests__/_probe.ts
      3. bun turbo check 2>&1 | tee /tmp/probe-out.txt; rm apps/backend/src/__tests__/_probe.ts
      4. grep -E "noExplicitAny|noConsole|noFloatingPromises" /tmp/probe-out.txt
    Expected Result: step 4 prints at least 3 matching rule names — Biome flagged all three violations
    Evidence: .omo/evidence/task-1-biome-rules.txt

  Scenario: Strict tsconfig enforced
    Tool: Bash
    Preconditions: scaffolding committed
    Steps:
      1. cat > apps/backend/src/__tests__/_strict-probe.ts <<'EOF'
         const arr: string[] = [];
         const x: string = arr[0];   // noUncheckedIndexedAccess: should error
         EOF
      2. bun turbo typecheck 2>&1 | tee /tmp/strict-out.txt; rm apps/backend/src/__tests__/_strict-probe.ts
      3. grep -E "Type 'string \\| undefined' is not assignable" /tmp/strict-out.txt && echo STRICT
    Expected Result: stdout prints STRICT (noUncheckedIndexedAccess fired)
    Evidence: .omo/evidence/task-1-strict-tsconfig.txt

  Scenario: Cross-workspace import resolves
    Tool: Bash
    Preconditions: bun install complete
    Steps:
      1. bun -e 'import {} from "@repo/types"; console.log("OK")'
    Expected Result: stdout prints "OK", exit=0
    Evidence: .omo/evidence/task-1-cross-workspace.txt

  Scenario: Banned deps absent
    Tool: Bash
    Preconditions: bun install complete
    Steps:
      1. for f in package.json apps/backend/package.json packages/types/package.json; do jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' "$f"; done | grep -E 'journeyapps|sentry|@opentelemetry|posthog|express|hono|fastify|prettier|eslint|husky' || echo CLEAN
    Expected Result: CLEAN
    Evidence: .omo/evidence/task-1-banned-deps.txt

  Scenario: Lefthook installed
    Tool: Bash
    Preconditions: bun install completed (prepare script ran)
    Steps:
      1. test -f .git/hooks/pre-commit && head -1 .git/hooks/pre-commit
    Expected Result: file exists; first line references lefthook
    Evidence: .omo/evidence/task-1-lefthook.txt

  Scenario: No deployment configs present
    Tool: Bash
    Preconditions: scaffolding committed
    Steps:
      1. find . -name 'vercel.json' -o -name 'fly.toml' -o -name 'render.yaml' -not -path './node_modules/*' | head -1 || echo CLEAN
    Expected Result: CLEAN
    Evidence: .omo/evidence/task-1-no-deploy-configs.txt

  Scenario: organizeImports enabled and effective
    Tool: Bash
    Preconditions: scaffolding committed
    Steps:
      1. cat > apps/backend/src/__tests__/_imports-probe.ts <<'EOF'
         import { z } from "./_fake";
         import type { A } from "./_fake";
         import { y } from "./_fake";
         export const _ = { y, z };
         export type _A = A;
         EOF
      2. bun run check:fix
      3. cat apps/backend/src/__tests__/_imports-probe.ts; rm apps/backend/src/__tests__/_imports-probe.ts
      4. Confirm: type imports grouped, value imports sorted
    Expected Result: type-only import on its own line via `import type`; value imports sorted alphabetically
    Evidence: .omo/evidence/task-1-organize-imports.txt
  ```

  **Commit**: YES — `chore: monorepo scaffolding (turborepo + bun workspaces + biome + strict tsconfig)`.

- [ ] 2. SQLCipher-under-Bun smoke spike

  **What to do**:
  - Create `bin/spike-sqlcipher.ts` that: opens `:memory:` DB via `better-sqlite3-multiple-ciphers`, runs `pragma("key = x'" + "00".repeat(31) + "11'")`, `pragma("cipher_compatibility = 4")`, creates a table, inserts and selects a row, closes, reopens, asserts row persists.
  - Add CI-style smoke: `bun run spike:sqlcipher` script.
  - Document the open sequence in `docs/encryption.md` (created in T25, stub here).
  - If spike fails: STOP and surface the failure — do not proceed to T7.

  **Must NOT do**:
  - Do NOT use a passphrase that triggers KDF (banned by Metis); raw hex only.
  - Do NOT enable WAL inside the spike (defer to T7 — WAL changes rekey semantics).
  - Do NOT silently fall back to plain SQLite if SQLCipher fails.

  **Recommended Agent Profile**:
  - **Category**: `deep` — needs to validate native binding behaviour and document the canonical open sequence.

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, with 3, 4, 5, 6)
  - **Blocks**: 7, 23, 24
  - **Blocked By**: 1

  **References**:
  - Metis quoted smoke test:
    ```bash
    bun -e 'const D=require("better-sqlite3-multiple-ciphers"); const d=new D(":memory:"); d.pragma("key = \"x'\''00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'\''\""); console.log(d.prepare("SELECT 1 as v").get())'
    ```
  - SQLCipher pragma reference: `https://www.zetetic.net/sqlcipher/sqlcipher-api/`

  **Acceptance Criteria**:
  - [ ] `bun run spike:sqlcipher` exits 0 and prints `{ v: 1 }`.
  - [ ] Spike reopens a file-backed DB and confirms a row inserted before close is readable after reopen with the same hex key.
  - [ ] Spike confirms wrong key returns `SQLITE_NOTADB` (documented in runbook).

  **QA Scenarios**:
  ```
  Scenario: Correct key opens, wrong key fails
    Tool: Bash
    Preconditions: bin/spike-sqlcipher.ts present
    Steps:
      1. bun run bin/spike-sqlcipher.ts
      2. Capture stdout/exit code
    Expected Result: stdout contains "{ v: 1 }", "REOPEN OK", "WRONG KEY REJECTED"; exit=0
    Failure Indicators: SQLITE_MISUSE, segfault, "not a database" on correct key
    Evidence: .omo/evidence/task-2-sqlcipher-spike.txt
  ```

  **Commit**: YES — `feat(db): sqlcipher binding spike`.

- [ ] 3. Cloudflared resilience spike

  **What to do**:
  - Create `bin/spike-cloudflared.ts` + `docs/spikes/cloudflared.md`.
  - Stand up a minimal `Bun.serve` on 127.0.0.1:8787 that logs every POST.
  - Manually (or scripted via `pkill -SIGKILL cloudflared && sleep 90 && cloudflared tunnel run ...`) simulate a 90s outage.
  - From a second shell, POST 10 messages spaced 10s apart during the outage; count how many arrive after tunnel resumes.
  - Document findings in `docs/spikes/cloudflared.md` including: GitHub does NOT auto-retry on 5xx/timeout, so any delivery missed during the outage is lost (within the 3-day UI / 7-day API redelivery window which v1 does not exploit).
  - Output: a clear go/no-go on whether cloudflared is acceptable, OR a documented fallback (e.g. systemd-managed restart, watchdog).

  **Must NOT do**:
  - Do NOT integrate cloudflared into the main process. It runs as a sidecar managed by launchd/systemd-user.
  - Do NOT implement programmatic GitHub redelivery API usage (out of scope for v1).

  **Recommended Agent Profile**:
  - **Category**: `deep` — empirical investigation with concrete count of lost messages.

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: 22 (entrypoint needs to know the failure mode)
  - **Blocked By**: 1

  **References**:
  - Cloudflare Tunnel docs: `https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/`
  - GitHub webhook retry policy: `https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries` — confirms no auto-retry.

  **Acceptance Criteria**:
  - [ ] `docs/spikes/cloudflared.md` exists with a numeric outcome ("X/10 messages received after 90s outage").
  - [ ] Decision recorded: continue with cloudflared OR switch ingress.
  - [ ] Runbook section drafted in `docs/runbook.md` (stub) covering "what to do if cloudflared is down >7 days" — answer: only REST reconciliation on next start recovers state.

  **QA Scenarios**:
  ```
  Scenario: Outage measurement recorded
    Tool: Bash
    Preconditions: spike script ran
    Steps:
      1. cat docs/spikes/cloudflared.md | grep -E "received: [0-9]+/10"
      2. cat docs/spikes/cloudflared.md | grep -E "^Decision:"
    Expected Result: both greps return one line each
    Evidence: .omo/evidence/task-3-cloudflared-spike.md (copy of doc)
  ```

  **Commit**: YES — `docs(spike): cloudflared resilience finding`.

- [ ] 4. fs.watch on macOS reliability spike

  **What to do**:
  - Create `bin/spike-fswatch.ts` that watches `tracked-repos.yaml` (test fixture) and logs every change event.
  - Test patterns: (a) direct write (`echo ... > file`), (b) atomic write (write to temp, rename), (c) editor save (vim with backup), (d) `touch`.
  - Document which patterns fire which events (`rename` vs `change`) and what the consumer must do (re-`watch` after `rename` to track the new inode).
  - Output: `docs/spikes/fswatch.md` with the canonical reload pattern for T17.

  **Must NOT do**:
  - Do NOT use a 3rd-party watcher (chokidar) — Bun has `fs.watch`. If `fs.watch` proves unreliable, surface that and propose polling fallback.

  **Recommended Agent Profile**:
  - **Category**: `deep` — needs empirical observation of fs events under multiple write patterns.

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: 17
  - **Blocked By**: 1

  **References**:
  - Node fs.watch docs (Bun mirrors API): `https://nodejs.org/api/fs.html#fswatchfilename-options-listener`

  **Acceptance Criteria**:
  - [ ] `docs/spikes/fswatch.md` documents 4 write patterns with observed event types.
  - [ ] Canonical reload algorithm specified (e.g. on `rename` event, re-establish watcher).

  **QA Scenarios**:
  ```
  Scenario: All 4 patterns produce detectable events
    Tool: interactive_bash
    Preconditions: bin/spike-fswatch.ts running in a tmux pane
    Steps:
      1. Run the spike in background, redirect to /tmp/fswatch.log
      2. In another pane: echo "test" >> tracked-repos.yaml
      3. cp -a tracked-repos.yaml tracked-repos.yaml.new && mv tracked-repos.yaml.new tracked-repos.yaml
      4. touch tracked-repos.yaml
      5. vim -c "wq" tracked-repos.yaml
      6. Check /tmp/fswatch.log captured at least one event per pattern
    Expected Result: log shows >=4 event lines, doc covers all patterns
    Evidence: .omo/evidence/task-4-fswatch.log
  ```

  **Commit**: YES — `docs(spike): fs.watch reliability matrix`.

- [ ] 5. SQL schema + migrations runner

  **What to do**:
  - Create `apps/backend/src/db/migrations/0001_init.sql` defining the following 8 tables exactly:
    - `repository(repo_id INTEGER PRIMARY KEY, owner_login TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)), added_at TEXT NOT NULL)` — `active=1` for repos listed in `tracked-repos.yaml`; soft-disabled when removed.
    - `person(user_id INTEGER PRIMARY KEY, login TEXT NOT NULL, avatar_url TEXT, first_seen_at TEXT NOT NULL)` — denormalized author + reviewer info for the read API; no tracking semantics, just display data.
    - `pull_request(github_pr_id INTEGER PRIMARY KEY, node_id TEXT NOT NULL, number INTEGER NOT NULL, repo_id INTEGER NOT NULL REFERENCES repository(repo_id), author_user_id INTEGER NOT NULL REFERENCES person(user_id), state TEXT NOT NULL CHECK(state IN ('open','closed')), draft INTEGER NOT NULL CHECK(draft IN (0,1)), title TEXT NOT NULL, head_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, merged_at TEXT, html_url TEXT NOT NULL, last_event_at TEXT NOT NULL)` — stores BOTH open and closed lifecycle. `closed_at` and `merged_at` are nullable; `merged_at` non-null means the PR was merged rather than declined.
    - `review(review_id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL REFERENCES pull_request(github_pr_id) ON DELETE CASCADE, reviewer_user_id INTEGER NOT NULL REFERENCES person(user_id), state TEXT NOT NULL CHECK(state IN ('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED')), submitted_at TEXT NOT NULL)`
    - `delivery_log(delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, action TEXT, received_at TEXT NOT NULL, processed_at TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('applied','dedup','stale','rejected','ignored')))`
    - `repo_state(repo_id INTEGER PRIMARY KEY REFERENCES repository(repo_id) ON DELETE CASCADE, last_reconciled_at TEXT NOT NULL)`
    - `api_token(token_id TEXT PRIMARY KEY, hash TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT)`
    - `schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)` (created by migrate.ts on first run if absent).
  - Indexes: `(state, repo_id, updated_at)` on `pull_request` (covers list-by-state + filter-by-repo + recency sort); `(author_user_id)` on `pull_request` (web-app author filter); `(pr_id)` on `review`; `(received_at)` on `delivery_log`; `(active)` on `repository`.
  - Create `apps/backend/src/db/migrate.ts`: opens encrypted DB, applies any unapplied migration files in `apps/backend/src/db/migrations/` (lexicographic order), records to `schema_migrations`.
  - `bun --filter @repo/backend run migrate` is the operator command.

  **Must NOT do**:
  - Do NOT add columns for PR body, comments, file diffs, branch ref name, commit messages.
  - Do NOT add `title_encrypted`/`login_encrypted` per-row encrypted columns (SQLCipher whole-DB only).
  - Do NOT add a column or table for merge-queue state.
  - Do NOT add a `tracked_user` table — user/author filtering belongs in the future web app.
  - Do NOT use SQLite views (keep schema flat and explicit for F1 audit).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — schema design with explicit privacy constraints.

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1, with 2, 3, 4, 6 after 6 lands types)
  - **Blocks**: 7, 10, 11, 12, 15
  - **Blocked By**: 1, 6

  **References**:
  - Data model section of this plan (above) is the source of truth.
  - SQLCipher migration considerations: `https://www.zetetic.net/sqlcipher/sqlcipher-api/#PRAGMA_rekey`

  **Acceptance Criteria**:
  - [ ] `bun --filter @repo/backend run migrate` against a fresh encrypted DB creates exactly 8 tables.
  - [ ] Re-running migrate is a no-op (idempotency).
  - [ ] `PRAGMA foreign_keys` enabled by migration runner.
  - [ ] CHECK constraints reject invalid `state`/`outcome`/`draft`/`active` values (proven by test).
  - [ ] All 5 indexes present (proven via `PRAGMA index_list`).

  **QA Scenarios**:
  ```
  Scenario: Fresh DB applies all migrations
    Tool: Bash
    Preconditions: rm -f apps/backend/data/prs.db; export PR_TRACKER_KEY=<64hex>
    Steps:
      1. bun --filter @repo/backend run migrate
      2. bun -e 'import {open} from "./apps/backend/src/db/connection"; const db = open(); console.log(db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\" ORDER BY name").all().map(r=>r.name).join(","))'
    Expected Result: stdout lists exactly: api_token,delivery_log,person,pull_request,repo_state,repository,review,schema_migrations
    Evidence: .omo/evidence/task-5-migrate-fresh.txt

  Scenario: CHECK constraints enforced (invalid state)
    Tool: Bash
    Preconditions: DB migrated
    Steps:
      1. bun -e 'import {open} from "./apps/backend/src/db/connection"; const db=open(); try { db.prepare("INSERT INTO pull_request (github_pr_id,node_id,number,repo_id,author_user_id,state,draft,title,head_sha,created_at,updated_at,html_url,last_event_at) VALUES (1,\"x\",1,1,1,\"merged\",0,\"t\",\"s\",\"\",\"\",\"\",\"\")").run(); console.log("FAIL: insert accepted"); } catch(e) { console.log("OK:"+e.message); }'
    Expected Result: stdout starts with "OK:" and mentions CHECK constraint
    Evidence: .omo/evidence/task-5-check-constraint.txt

  Scenario: Indexes present
    Tool: Bash
    Preconditions: DB migrated
    Steps:
      1. bun -e 'import {open} from "./apps/backend/src/db/connection"; const db = open(); for (const t of ["pull_request","review","delivery_log","repository"]) console.log(t+":"+db.prepare("SELECT name FROM sqlite_master WHERE type=\"index\" AND tbl_name=?").all(t).map(r=>r.name).join(","))'
    Expected Result: each line shows non-empty index list for pull_request, review, delivery_log, repository
    Evidence: .omo/evidence/task-5-indexes.txt
  ```

  **Commit**: YES — `feat(db): schema + migration runner`.

- [ ] 6. Shared types package contents (`packages/types/src/`)

  > Workspace skeleton (`package.json`, `tsconfig.json`, `exports` map, placeholder `index.ts`) already shipped by T1. This task fills in the actual types.

  **What to do**:
  - In `packages/types/src/`, populate:
    - `domain.ts` — TS types matching the T5 schema 1:1: `PullRequest`, `Repository`, `Person`, `Review`, `DeliveryLog`, `RepoState`, `ApiToken`. NO `TrackedUser` (removed in round-2 pivot).
    - `branded.ts` — branded number types: `type GitHubUserId = number & { readonly __brand: 'GitHubUserId' }`, `GitHubRepoId`, `GitHubPrId`, `GitHubReviewId`. Export constructor helpers (`asUserId(n: number): GitHubUserId`) that assert positive integers at runtime.
    - `enums.ts` — string-literal unions: `type PrState = 'open' | 'closed'`, `type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'`, `type DeliveryOutcome = 'applied' | 'dedup' | 'stale' | 'rejected' | 'ignored'`.
    - `github.ts` — narrowed webhook payload types: only the fields actually consumed by handlers (`PullRequestEvent`, `PullRequestReviewEvent`, `RepositoryRenamedEvent`).
    - `api.ts` — Read API response shapes (`PullRequestListItem`, `PullRequestDetail`, `RepoSummary`) — the contract the future web app will consume.
    - `index.ts` — re-exports from the above files. Because `noBarrelFile` is enforced by Biome, this file gets a `// biome-ignore lint/performance/noBarrelFile: package public entrypoint` directive at the top. Inner re-exports use named exports (no `export *`) to keep `noReExportAll` happy.

  **Must NOT do**:
  - Do NOT re-export full Octokit types (huge surface). Define narrowed types locally.
  - Do NOT add types for unsubscribed events (`pull_request_review_comment`, `issue_comment`, etc.).
  - Do NOT add a `TrackedUser` type.
  - Do NOT depend on Bun-specific or Node-specific runtime APIs in this package — types only, framework-free, so a future browser-side web app can import it.
  - Do NOT use `export *` (`noReExportAll` is enforced). Only named re-exports in `index.ts`.
  - Do NOT use `// biome-ignore` outside of `index.ts`'s single barrel-file directive.

  **Recommended Agent Profile**:
  - **Category**: `quick` — straightforward type definitions.

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: 5, 7, 10-22
  - **Blocked By**: 1

  **References**:
  - GitHub webhook payload schema: `https://docs.github.com/en/webhooks/webhook-events-and-payloads`

  **Acceptance Criteria**:
  - [ ] `bun turbo typecheck` clean across both workspaces.
  - [ ] `bun turbo check` clean (Biome lint + format) for `packages/types/src/`.
  - [ ] Brand types prevent passing `GitHubUserId` where `GitHubRepoId` is expected (proven by a `// @ts-expect-error` test in `packages/types/src/__tests__/brand.test.ts`).
  - [ ] No occurrences of `: any` or `as any` in `packages/types/src/` (also enforced by Biome's `noExplicitAny`).
  - [ ] `packages/types` has zero runtime dependencies (`jq '.dependencies | length' packages/types/package.json` = 0).
  - [ ] No `export *` anywhere (`noReExportAll` clean); only the single `// biome-ignore lint/performance/noBarrelFile:` directive on `index.ts`.
  - [ ] `@repo/types` importable from `apps/backend` AND from a bun-run dry test simulating a browser-only consumer (no Bun/Node API references).

  **QA Scenarios**:
  ```
  Scenario: Brand types enforced + Biome clean
    Tool: Bash
    Preconditions: types committed
    Steps:
      1. bun turbo typecheck
      2. bun turbo check --filter @repo/types
      3. grep -rn ": any\|as any" packages/types/src/ || echo CLEAN
    Expected Result: typecheck exit=0, check exit=0, grep prints CLEAN
    Evidence: .omo/evidence/task-6-types.txt

  Scenario: No runtime deps (browser-safe)
    Tool: Bash
    Preconditions: types package committed
    Steps:
      1. jq '.dependencies // {}' packages/types/package.json
      2. grep -rE "from \"(bun|node:|fs|path|crypto)\"" packages/types/src/ || echo CLEAN
    Expected Result: step 1 prints "{}" or empty object; step 2 prints CLEAN
    Evidence: .omo/evidence/task-6-no-deps.txt

  Scenario: Single barrel directive on index.ts only
    Tool: Bash
    Preconditions: types committed
    Steps:
      1. grep -rln "biome-ignore" packages/types/src/
      2. grep -rln "export \\*" packages/types/src/ || echo CLEAN
    Expected Result: step 1 prints exactly "packages/types/src/index.ts"; step 2 prints CLEAN
    Evidence: .omo/evidence/task-6-barrel.txt
  ```

  **Commit**: YES — `feat(types): @repo/types domain + api shapes`.

- [ ] 7. Encrypted DB connector module

  **What to do**:
  - Create `src/db/connection.ts` exporting `open(): Database` and `close(db): void`.
  - Key resolution order: `PR_TRACKER_KEY` env var → `security find-generic-password -s github-pr-tracker -a sqlcipher -w` (macOS Keychain). Key MUST be 64 hex chars; reject otherwise.
  - Open sequence (LOCKED): `new Database(path)` → `pragma("key = x'" + hex + "'")` → `pragma("cipher_compatibility = 4")` → `pragma("journal_mode = WAL")` → `pragma("foreign_keys = ON")` → first `SELECT 1`.
  - Provide `rekey(newHex)` helper that follows the runbook: `wal_checkpoint(TRUNCATE)` → `journal_mode = DELETE` → `rekey x'...'` → `journal_mode = WAL`.
  - Provide `selfTest()` invoked by entrypoint: opens, runs `SELECT 1`, closes — fails loud if binding broken.
  - Path resolves to `data/prs.db` by default; configurable via `PR_TRACKER_DB` for tests.

  **Must NOT do**:
  - Do NOT log the key, ever (even partially).
  - Do NOT accept a passphrase. Raw hex only. Reject non-hex/non-64-char input with a clear error (not "not a database").
  - Do NOT enable WAL before key pragma.
  - Do NOT rekey under WAL.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — security-critical module with strict open sequence.

  **Parallelization**:
  - **Can Run In Parallel**: NO within Wave 1 (depends on 2, 5, 6)
  - **Blocks**: 10-22
  - **Blocked By**: 1, 2, 5, 6

  **References**:
  - SQLCipher whole-DB encryption docs: `https://www.zetetic.net/sqlcipher/design/`
  - Metis: "PRAGMA key error masquerades as 'not a database'" → expose a custom error.

  **Acceptance Criteria**:
  - [ ] `open()` with valid key returns a working DB; `selfTest()` reports `SELECT 1 = 1`.
  - [ ] `open()` with malformed key (not 64 hex) throws `InvalidKeyFormatError`.
  - [ ] `open()` against a DB created with a different key throws `WrongKeyError` (wrapping `SQLITE_NOTADB`).
  - [ ] `rekey()` succeeds and the new key can subsequently `open()`; the old key can no longer.
  - [ ] No key material appears in any log file.

  **QA Scenarios**:
  ```
  Scenario: Wrong key produces clear error
    Tool: Bash
    Preconditions: data/prs.db created with key A
    Steps:
      1. PR_TRACKER_KEY=$(openssl rand -hex 32) bun -e 'import {open} from "./apps/backend/src/db/connection"; try { open(); } catch(e) { console.log(e.constructor.name+":"+e.message) }'
    Expected Result: stdout starts with "WrongKeyError" and message contains hint about key mismatch
    Evidence: .omo/evidence/task-7-wrong-key.txt

  Scenario: Rekey runbook works
    Tool: Bash
    Preconditions: data/prs.db with key A, rows present
    Steps:
      1. bun -e 'import {open, rekey} from "./apps/backend/src/db/connection"; const db=open(); rekey(db, process.env.NEW_KEY); db.close();' (with NEW_KEY set)
      2. PR_TRACKER_KEY=$NEW_KEY bun -e 'import {open} from "./apps/backend/src/db/connection"; console.log(open().prepare("SELECT COUNT(*) c FROM repository").get())'
    Expected Result: step 2 prints a count >= 0; step 1 with old key now fails
    Evidence: .omo/evidence/task-7-rekey.txt
  ```

  **Commit**: YES — `feat(db): encrypted connector with rekey`.

- [ ] 8. HMAC signature verifier

  **What to do**:
  - Create `src/webhook/verify.ts` exporting `verifySignature(rawBody: Buffer, headerValue: string | null, secret: string): boolean`.
  - Compute `sha256=` + HMAC-SHA256(secret, rawBody) using `crypto.createHmac`.
  - Constant-time compare via `crypto.timingSafeEqual` after length check.
  - Return `false` (never throw) for: missing header, malformed prefix, length mismatch, signature mismatch.
  - Secret loaded from `GITHUB_WEBHOOK_SECRET` env var (caller responsibility).

  **Must NOT do**:
  - Do NOT use `===` or `Buffer.compare` for comparison.
  - Do NOT log the secret or computed digest.
  - Do NOT trust `X-Hub-Signature` (SHA-1) — only `X-Hub-Signature-256`.

  **Recommended Agent Profile**:
  - **Category**: `quick` — small, well-defined crypto primitive.

  **Parallelization**: Wave 2, parallel with 9, 10, 11, 12.
  - **Blocks**: 13
  - **Blocked By**: 1, 6

  **References**:
  - GitHub signature docs: `https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries`

  **Acceptance Criteria**:
  - [ ] Valid signature returns `true`.
  - [ ] Off-by-one-byte signature returns `false`.
  - [ ] Missing header returns `false` (no throw).
  - [ ] `bun test src/webhook/verify.test.ts` covers all 4 cases.

  **QA Scenarios**:
  ```
  Scenario: Known GitHub example verifies
    Tool: Bash
    Preconditions: verify module committed
    Steps:
      1. bun test src/webhook/verify.test.ts --reporter=tap
    Expected Result: TAP output shows all assertions pass, "verifies known-good fixture" included
    Evidence: .omo/evidence/task-8-verify.txt
  ```

  **Commit**: YES — `feat(webhook): hmac sha256 verifier`.

- [ ] 9. Delivery dedup store

  **What to do**:
  - Create `src/webhook/dedup.ts` exporting `recordDelivery(db, deliveryId, event, action): 'new' | 'dup'`.
  - `INSERT OR IGNORE INTO delivery_log` keyed on `delivery_id`. `changes()` after insert tells you new vs dup.
  - On `dup`: caller should respond 200 immediately without re-processing.
  - Provide `markOutcome(db, deliveryId, outcome)` to record `applied|stale|rejected|ignored` after processing.

  **Must NOT do**:
  - Do NOT store the payload body in `delivery_log`.
  - Do NOT use an in-memory Set (must survive restart).

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**: Wave 2.
  - **Blocks**: 13
  - **Blocked By**: 1, 5, 7

  **Acceptance Criteria**:
  - [ ] First call with a delivery_id returns `'new'`.
  - [ ] Second call with the same id returns `'dup'`.
  - [ ] `markOutcome` updates `processed_at` and `outcome`.

  **QA Scenarios**:
  ```
  Scenario: Idempotency under repeat
    Tool: Bash
    Preconditions: empty DB
    Steps:
      1. bun test src/webhook/dedup.test.ts --reporter=tap
    Expected Result: all assertions pass; one test specifically asserts second call returns 'dup'
    Evidence: .omo/evidence/task-9-dedup.txt
  ```

  **Commit**: YES — `feat(webhook): delivery dedup`.

- [ ] 10. pull_request handler (7 actions + repo allowlist + ordering fence + ghost guard)

  **What to do**:
  - Create `apps/backend/src/handlers/pull-request.ts` exporting `handlePullRequest(db, payload): DeliveryOutcome`.
  - Accept ONLY actions: `opened, reopened, closed, converted_to_draft, ready_for_review, synchronize, edited`. Any other action → return `'ignored'` (including `enqueued`/`dequeued`/`labeled`/`assigned` etc.).
  - Org allowlist check: `payload.repository.owner.login` must match configured org (`GITHUB_ORG` env). Mismatch → `'rejected'`.
  - **Repo allowlist check (NEW in round 2)**: if `payload.repository.id` NOT in `repository` where `active=1` → `'ignored'` (NOT rejected — org-level webhook fires for repos we don't care about, that's expected).
  - Ghost runtime guard: if `payload.pull_request.user.id === 10137` AND no existing row for `github_pr_id` → `'rejected'` (cannot attribute author).
  - Ordering fence: if existing row found and `existing.updated_at >= payload.pull_request.updated_at` → `'stale'`.
  - Upsert `person` (user_id, login, avatar_url, first_seen_at) for the PR author.
  - Upsert `pull_request` with all 15 columns (incl. `closed_at`, `merged_at`).
  - On `closed`:
    - `state='closed'`.
    - `closed_at = payload.pull_request.closed_at` (always present on closed).
    - `merged_at = payload.pull_request.merged_at` (null when declined, ISO timestamp when merged).
  - On `reopened`: `state='open'`, `closed_at=null`, `merged_at=null`.
  - On `converted_to_draft`: `draft=1`.
  - On `ready_for_review`: `draft=0`.
  - Wrap in a single transaction.

  **Must NOT do**:
  - Do NOT store `payload.pull_request.body`, `payload.pull_request.head.ref`, file diffs, commit messages.
  - Do NOT call GitHub API from this handler.
  - Do NOT process actions outside the 7-action allowlist.
  - Do NOT delete rows on `closed` (closed PRs are now first-class data).
  - Do NOT filter by author (no user subset in v1).
  - Do NOT INSERT into `repository` from this handler — repository rows are owned by T16 (config sync). If the repo isn't in `tracked-repos.yaml`, the event is `'ignored'`, period.

  **Recommended Agent Profile**:
  - **Category**: `deep` — multi-branch logic, ordering fence is subtle, ghost handling matters.

  **Parallelization**: Wave 2.
  - **Blocks**: 13, 15, 23
  - **Blocked By**: 5, 7

  **References**:
  - `pull_request` payload schema: `https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request`
  - Metis ordering fence rule (this plan, "Must Have").

  **Acceptance Criteria**:
  - [ ] All 7 actions update DB state correctly.
  - [ ] 8th action (`labeled`) returns `'ignored'` with no DB write.
  - [ ] Out-of-order test: closed (T+2) then opened (T+1) → final state=closed; synchronize (T+0) → state still closed and outcome `'stale'`.
  - [ ] Ghost user (id=10137) NEW PR → `'rejected'`, no row inserted.
  - [ ] Event for untracked repo (not in `repository where active=1`) → `'ignored'`, no row inserted; outcome recorded.
  - [ ] `closed` action with `merged_at` populated → `merged_at` stored; with `merged_at=null` → declined PR retained.
  - [ ] `reopened` action → `state='open'`, `closed_at=null`, `merged_at=null`.

  **QA Scenarios**:
  ```
  Scenario: Out-of-order updates respect fence
    Tool: Bash
    Preconditions: DB migrated, repo X active
    Steps:
      1. bun --filter @repo/backend test src/handlers/pull-request.test.ts -t "ordering fence"
    Expected Result: test passes; assertion proves stale update is dropped and outcome recorded as 'stale'
    Evidence: .omo/evidence/task-10-ordering.txt

  Scenario: Ghost author rejected on new row
    Tool: Bash
    Preconditions: tracked repo X active, no existing PR row
    Steps:
      1. bun --filter @repo/backend test src/handlers/pull-request.test.ts -t "ghost author new PR"
    Expected Result: test passes; SELECT COUNT(*) FROM pull_request WHERE author_user_id=10137 = 0
    Evidence: .omo/evidence/task-10-ghost.txt

  Scenario: Untracked repo ignored
    Tool: Bash
    Preconditions: repo Y NOT in active set
    Steps:
      1. bun --filter @repo/backend test src/handlers/pull-request.test.ts -t "untracked repo"
    Expected Result: test passes; outcome 'ignored'; SELECT COUNT(*) FROM pull_request WHERE repo_id=<Y> = 0
    Evidence: .omo/evidence/task-10-untracked-repo.txt

  Scenario: Closed PR retains merged metadata
    Tool: Bash
    Preconditions: PR opened then closed (merged)
    Steps:
      1. bun --filter @repo/backend test src/handlers/pull-request.test.ts -t "merged close stores merged_at"
    Expected Result: test passes; merged_at non-null, closed_at non-null, state='closed'
    Evidence: .omo/evidence/task-10-merged.txt

  Scenario: Disallowed action ignored
    Tool: Bash
    Preconditions: existing PR row
    Steps:
      1. bun --filter @repo/backend test src/handlers/pull-request.test.ts -t "labeled action ignored"
    Expected Result: test passes; outcome 'ignored', row unchanged
    Evidence: .omo/evidence/task-10-labeled-ignored.txt
  ```

  **Commit**: YES — `feat(handlers): pull_request with repo allowlist, fence, ghost guard`.

- [ ] 11. pull_request_review handler

  **What to do**:
  - Create `src/handlers/pull-request-review.ts` exporting `handlePullRequestReview(db, payload): DeliveryOutcome`.
  - Accept actions: `submitted, dismissed, edited`. Others → `'ignored'`.
  - Require parent PR row to exist (`pull_request.github_pr_id = payload.pull_request.id`). Missing → `'rejected'`.
  - Upsert `review` keyed on `review_id` (from `payload.review.id`).
  - Map `payload.review.state.toUpperCase()` to enum; `dismissed` action sets state='DISMISSED'.

  **Must NOT do**:
  - Do NOT store `payload.review.body`.
  - Do NOT create a PR row if the parent is missing (handle drift via reconciliation).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`.

  **Parallelization**: Wave 2.
  - **Blocks**: 13
  - **Blocked By**: 5, 7

  **Acceptance Criteria**:
  - [ ] Submitted review inserts row with mapped state.
  - [ ] Dismissed action sets state='DISMISSED' regardless of `payload.review.state`.
  - [ ] Missing parent PR → `'rejected'`, no row.
  - [ ] Unsupported action (`requested`) → `'ignored'`.

  **QA Scenarios**:
  ```
  Scenario: Review insert and dismiss
    Tool: Bash
    Preconditions: parent PR row exists
    Steps:
      1. bun test src/handlers/pull-request-review.test.ts --reporter=tap
    Expected Result: all assertions pass; dismissed test asserts state='DISMISSED' in DB
    Evidence: .omo/evidence/task-11-review.txt
  ```

  **Commit**: YES — `feat(handlers): pull_request_review`.

- [ ] 12. repository.renamed handler

  **What to do**:
  - Create `src/handlers/repository.ts` exporting `handleRepository(db, payload): DeliveryOutcome`.
  - Accept action `renamed` only. Others → `'ignored'`.
  - `UPDATE repository SET name = payload.repository.name, owner_login = payload.repository.owner.login WHERE repo_id = payload.repository.id`.
  - If no row updated (repo not tracked): `'ignored'`.

  **Must NOT do**:
  - Do NOT insert a new repository row on rename (only update existing).
  - Do NOT touch any PR rows.

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**: Wave 2.
  - **Blocks**: 13
  - **Blocked By**: 5, 7

  **Acceptance Criteria**:
  - [ ] Existing repo's name is updated.
  - [ ] Untracked repo rename returns `'ignored'`.

  **QA Scenarios**:
  ```
  Scenario: Rename updates name
    Tool: Bash
    Preconditions: repository row exists with name='old-name'
    Steps:
      1. bun test src/handlers/repository.test.ts -t "rename updates name"
    Expected Result: test passes; SELECT name verifies 'new-name'
    Evidence: .omo/evidence/task-12-rename.txt
  ```

  **Commit**: YES — `feat(handlers): repository.renamed`.

- [ ] 13. Webhook HTTP server

  **What to do**:
  - Create `src/server/webhook.ts` exporting `startWebhookServer(opts): Server`.
  - `Bun.serve({ hostname: '127.0.0.1', port: 8787, fetch })`.
  - Routes:
    - `POST /webhook`: read raw body; reject if length > 25 MiB; verify HMAC via T8; parse JSON; dedup via T9; dispatch by `X-GitHub-Event` header to T10/T11/T12; record outcome; respond 200 with `{"ok":true}` (or 204).
    - `GET /ping`: 200 (for cloudflared health checks; no auth).
    - All other routes/methods: 404.
  - Error budget: total handler time ≤ 1000ms p99 (safe margin under GitHub's 10s).
  - Wrap dispatch in `try/catch`; on unexpected error: respond 500 (GitHub will not retry; record outcome 'rejected' with reason).
  - Allowlist-log: `{event, action, delivery_id, status, duration_ms, outcome}` only.

  **Must NOT do**:
  - Do NOT bind `0.0.0.0`, do NOT bind `::`, do NOT expose any other port.
  - Do NOT log payload, login, title, or any free-text field from the payload.
  - Do NOT respond before HMAC verification.
  - Do NOT throw on dedup hit; respond 200 with `{ok: true, outcome: 'dedup'}`.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — orchestrates 5 modules.

  **Parallelization**: Wave 2 final.
  - **Blocks**: 22, 23
  - **Blocked By**: 7, 8, 9, 10, 11, 12, 21

  **References**:
  - Bun.serve: `https://bun.sh/docs/api/http`

  **Acceptance Criteria**:
  - [ ] Server starts and `lsof -iTCP:8787 -sTCP:LISTEN` shows `127.0.0.1` only.
  - [ ] `curl http://0.0.0.0:8787/webhook` is refused (connection reset).
  - [ ] Valid signed POST returns 200 within 1000ms.
  - [ ] Wrong signature returns 401.
  - [ ] Body > 25 MiB returns 413.
  - [ ] Duplicate delivery returns 200 with outcome 'dedup' in log.
  - [ ] No payload/login/title appears in `logs/app.log`.

  **QA Scenarios**:
  ```
  Scenario: Bound to loopback only
    Tool: Bash
    Preconditions: server started
    Steps:
      1. lsof -iTCP:8787 -sTCP:LISTEN -P -n
      2. curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 2 http://$(ipconfig getifaddr en0):8787/ping || echo REFUSED
    Expected Result: step 1 shows "127.0.0.1:8787"; step 2 prints REFUSED or timeout
    Evidence: .omo/evidence/task-13-binding.txt

  Scenario: Signed payload accepted, wrong signature rejected
    Tool: Bash
    Preconditions: GITHUB_WEBHOOK_SECRET set
    Steps:
      1. BODY='{"action":"opened","pull_request":{...},"repository":{...}}'
      2. SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" | awk '{print $2}')"
      3. curl -sS -o /dev/null -w "%{http_code}\n" -H "X-Hub-Signature-256: $SIG" -H "X-GitHub-Event: pull_request" -H "X-GitHub-Delivery: $(uuidgen)" -H "Content-Type: application/json" -d "$BODY" http://127.0.0.1:8787/webhook
      4. curl -sS -o /dev/null -w "%{http_code}\n" -H "X-Hub-Signature-256: sha256=deadbeef" -H "X-GitHub-Event: pull_request" -H "X-GitHub-Delivery: $(uuidgen)" -d "$BODY" http://127.0.0.1:8787/webhook
    Expected Result: step 3 prints 200; step 4 prints 401
    Evidence: .omo/evidence/task-13-signed.txt

  Scenario: No PII in logs after a real event
    Tool: Bash
    Preconditions: a valid signed POST applied
    Steps:
      1. grep -E "(title|login|body|name@)" logs/app.log || echo CLEAN
    Expected Result: CLEAN
    Evidence: .omo/evidence/task-13-no-pii.txt
  ```

  **Commit**: YES — `feat(server): webhook server on loopback`.

- [ ] 14. Octokit REST client

  **What to do**:
  - Create `src/github/client.ts` exporting `makeClient(token: string)` returning an `Octokit` instance with a custom request hook that pauses on `X-RateLimit-Remaining < 10` until `X-RateLimit-Reset`.
  - Token loaded from `GITHUB_RECONCILE_TOKEN` env var ONLY at startup; never persisted in DB.
  - Provide `listOpenPullsForRepo(client, owner, repo): Promise<PullRequestPayload[]>` paginating `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`.
  - Set `User-Agent: github-pr-tracker/0.1`.

  **Must NOT do**:
  - Do NOT call any read-path endpoint at runtime (only during reconciliation).
  - Do NOT log the token, even partially.
  - Do NOT call `/search/issues` (the rate limits are much tighter; use per-repo pulls list).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`.

  **Parallelization**: Wave 3.
  - **Blocks**: 15
  - **Blocked By**: 6

  **References**:
  - Octokit: `https://github.com/octokit/rest.js`
  - GitHub REST pulls list: `https://docs.github.com/en/rest/pulls/pulls#list-pull-requests`

  **Acceptance Criteria**:
  - [ ] Client paginates correctly (test against a fixture with 250 PRs across 3 pages, mocked).
  - [ ] Rate-limit hook pauses when remaining < 10 (proven by mock).
  - [ ] No token appears in any log.

  **QA Scenarios**:
  ```
  Scenario: Pagination and rate-limit pause
    Tool: Bash
    Preconditions: mock server fixtures present
    Steps:
      1. bun test src/github/client.test.ts --reporter=tap
    Expected Result: all assertions pass; rate-limit pause test asserts a measurable delay
    Evidence: .omo/evidence/task-14-client.txt
  ```

  **Commit**: YES — `feat(github): octokit client with rate-limit hook`.

- [ ] 15. Reconciliation service (per configured repo, state=all)

  **What to do**:
  - Create `apps/backend/src/reconcile/index.ts` exporting `reconcileAll(db, client, activeRepos): Promise<ReconcileReport>`.
  - `activeRepos` is the list returned by `SELECT repo_id, owner_login, name FROM repository WHERE active=1`.
  - For each repo: call `listPullsForRepo(owner, repo, state='all')` (the renamed/expanded T14 helper) — paginated, includes both open AND closed PRs. **Caveat**: GitHub's `state=all` returns ALL closed PRs ever; cap the reconciliation at `?sort=updated&direction=desc&per_page=100` for the first N pages and stop when older than `repo_state.last_reconciled_at - 7d` (covers GitHub's redelivery gap). On first-ever reconciliation (no checkpoint), fetch until you hit a PR older than 90 days, then stop. This bounds initial cost on long-lived repos.
  - For each returned PR (regardless of author, except ghost): apply via the same upsert path used by T10 (extract a shared `upsertPullRequestFromRestPayload(db, payload)` helper into `apps/backend/src/handlers/pull-request.ts` and have T10 import the same upsert from there).
    - Skip if `user.id === 10137` AND no existing row.
    - Skip the repo allowlist check here (we already enumerated by `active=1`).
  - For each PR in DB with `state='open'` and `repo_id` in this repo and NOT present (with `state='open'`) in the REST result: mark `state='closed'` and set `closed_at` to the value REST returned (if the PR was returned with `state='closed'`) or to `NOW()` as a fallback. Drift detected.
  - Update `repo_state.last_reconciled_at = NOW()` for each repo.
  - `ReconcileReport = { repos: number, upserted: number, drift_closed: number, duration_ms: number }`.

  **Must NOT do**:
  - Do NOT delete rows.
  - Do NOT touch `review` rows (reviews reconcile via webhooks only — accept eventual drift).
  - Do NOT proceed if `GITHUB_RECONCILE_TOKEN` is unset — log a single warning line and skip reconciliation (the service still starts; drift will accumulate until the token is provided).
  - Do NOT call `/orgs/{org}/repos` here to discover repos — that's deliberately rejected; the operator controls the set via `tracked-repos.yaml`.

  **Recommended Agent Profile**:
  - **Category**: `deep` — drift detection logic is subtle.

  **Parallelization**: Wave 3.
  - **Blocks**: 22
  - **Blocked By**: 5, 7, 10, 14, 16

  **Acceptance Criteria**:
  - [ ] Empty DB + REST returns 3 open + 2 closed PRs for an active repo → 5 rows inserted with correct states.
  - [ ] DB has PR #5 open + REST returns #5 as closed → PR #5 marked closed with `closed_at` from REST.
  - [ ] DB has PR #6 open + REST omits #6 entirely → PR #6 marked closed with `closed_at = NOW()` (fallback drift).
  - [ ] Repo with `active=0` is skipped entirely (no REST call).
  - [ ] First reconciliation stops at 90-day age cutoff; subsequent reconciliation stops at `last_reconciled_at - 7d`.
  - [ ] Missing `GITHUB_RECONCILE_TOKEN` → warning logged, service continues, no crash.
  - [ ] `repo_state.last_reconciled_at` updated for each reconciled repo.

  **QA Scenarios**:
  ```
  Scenario: Mixed open + closed seeded
    Tool: Bash
    Preconditions: empty DB; mock REST returns 3 open + 2 closed for repo X (active)
    Steps:
      1. bun --filter @repo/backend test src/reconcile/index.test.ts -t "seed mixed states"
    Expected Result: 5 PRs inserted; SELECT COUNT(*) GROUP BY state = {open: 3, closed: 2}
    Evidence: .omo/evidence/task-15-seed-mixed.txt

  Scenario: Drift closes missing PRs
    Tool: Bash
    Preconditions: DB has open PR #6; mock REST omits #6
    Steps:
      1. bun --filter @repo/backend test src/reconcile/index.test.ts -t "drift fallback close"
    Expected Result: SELECT state FROM pull_request WHERE github_pr_id=6 returns 'closed' with non-null closed_at
    Evidence: .omo/evidence/task-15-drift.txt

  Scenario: Inactive repo skipped
    Tool: Bash
    Preconditions: repo Y with active=0
    Steps:
      1. bun --filter @repo/backend test src/reconcile/index.test.ts -t "inactive repo skipped"
    Expected Result: zero REST calls for Y (proven by mock call counter); no rows touched
    Evidence: .omo/evidence/task-15-skip-inactive.txt

  Scenario: Missing token degrades gracefully
    Tool: Bash
    Preconditions: GITHUB_RECONCILE_TOKEN unset
    Steps:
      1. bun --filter @repo/backend test src/reconcile/index.test.ts -t "missing token warns"
    Expected Result: warning log captured, reconcileAll resolves without throw, ReconcileReport.repos = 0
    Evidence: .omo/evidence/task-15-missing-token.txt
  ```

  **Commit**: YES — `feat(reconcile): startup reconciliation, state=all, drift fallback`.

- [ ] 16. tracked-repos.yaml loader + DB sync

  **What to do**:
  - Create `apps/backend/src/config/tracked-repos.ts` exporting `loadTrackedRepos(path: string): TrackedRepoConfig`.
  - Schema (YAML) at monorepo root `tracked-repos.yaml`:
    ```yaml
    org: my-private-org
    repos:
      - repo_id: 1296269       # numeric GitHub repo id (stable)
        owner: my-private-org
        name: hello-world
      - repo_id: 1296270
        owner: my-private-org
        name: backend-api
    ```
  - Validate: `org` non-empty; `repos` non-empty array; each entry has integer `repo_id`, non-empty `owner` matching top-level `org` (case-insensitive), non-empty `name`.
  - Validate no duplicate `repo_id` values.
  - Export `syncToDb(db, config): SyncReport` which:
    - Upserts each config entry into `repository` with `active=1` and `added_at` (preserve existing if row exists).
    - Marks any `repository` row NOT in the config as `active=0` (soft-disable; preserves historical PRs for the read API while the handler/reconciler stop touching them).
  - Provide `getActiveRepos(db): RepoSummary[]` helper used by reconciliation and the read API.

  **Must NOT do**:
  - Do NOT delete `repository` rows or any of their child PRs/reviews; soft-disable only.
  - Do NOT accept additional fields (env, labels, etc.) — strict schema.
  - Do NOT call GitHub to validate the repo exists (configuration trust is the operator's responsibility; reconciliation will surface 404s).
  - Do NOT include any user/author list. Per round-2 pivot, this config is repo-only.

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**: Wave 3.
  - **Blocks**: 15, 17, 22
  - **Blocked By**: 5, 6, 7

  **Acceptance Criteria**:
  - [ ] Valid YAML loads into typed `TrackedRepoConfig`.
  - [ ] Duplicate `repo_id` → throws `DuplicateRepoError`.
  - [ ] `owner` mismatching top-level `org` → throws `OrgMismatchError`.
  - [ ] `syncToDb` marks repos absent from YAML as `active=0`; previously-present rows keep their existing PRs untouched.
  - [ ] Adding a new repo to YAML inserts a `repository` row with `active=1` and a fresh `added_at`.

  **QA Scenarios**:
  ```
  Scenario: Soft disable on removal preserves history
    Tool: Bash
    Preconditions: DB has repos X (active) and Y (active) with PRs under each
    Steps:
      1. bun --filter @repo/backend test src/config/tracked-repos.test.ts -t "soft disable preserves PRs"
    Expected Result: passes; after removing Y from YAML and syncToDb: repository.active=0 for Y; pull_request rows for Y untouched
    Evidence: .omo/evidence/task-16-soft-disable.txt

  Scenario: Org mismatch rejected
    Tool: Bash
    Preconditions: fixture YAML has org=A but one repo with owner=B
    Steps:
      1. bun --filter @repo/backend test src/config/tracked-repos.test.ts -t "org mismatch"
    Expected Result: throws OrgMismatchError before syncToDb runs
    Evidence: .omo/evidence/task-16-org-mismatch.txt

  Scenario: Duplicate repo_id rejected
    Tool: Bash
    Preconditions: fixture YAML lists same repo_id twice
    Steps:
      1. bun --filter @repo/backend test src/config/tracked-repos.test.ts -t "duplicate repo_id"
    Expected Result: throws DuplicateRepoError
    Evidence: .omo/evidence/task-16-duplicate.txt
  ```

  **Commit**: YES — `feat(config): tracked-repos loader and DB sync`.

- [ ] 17. Config hot-reload watcher (`tracked-repos.yaml`)

  **What to do**:
  - Create `apps/backend/src/config/watcher.ts` exporting `watchTrackedRepos(path, onChange: (config) => void): { stop: () => void }`.
  - Use `fs.watch` per the T4 spike findings. On `rename` event, re-establish the watcher against the new inode (handles atomic-rename editors).
  - Debounce: coalesce events within 500ms before invoking `onChange`.
  - On parse/validation failure: log structured error, do NOT call `onChange` (keep last-good config in memory).
  - `onChange` callback runs `loadTrackedRepos` + `syncToDb` from T16.
  - Path resolves to `<monorepo-root>/tracked-repos.yaml`; configurable via `TRACKED_REPOS_PATH` for tests.

  **Must NOT do**:
  - Do NOT install chokidar or any 3rd-party watcher.
  - Do NOT crash the process on a bad reload — log and continue.
  - Do NOT trigger a full reconciliation on every config change (that's expensive; reconciliation is startup-only). Just sync the `repository.active` flag.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`.

  **Parallelization**: Wave 3.
  - **Blocks**: 22
  - **Blocked By**: 16, 4

  **Acceptance Criteria**:
  - [ ] Direct write triggers onChange within 2s.
  - [ ] Atomic rename (`mv tmp file`) triggers onChange within 2s.
  - [ ] Invalid YAML keeps last-good config; onChange NOT called.
  - [ ] Debounce: 5 rapid writes within 200ms → onChange called once.
  - [ ] Reconciliation is NOT triggered by reload (only `repository.active` sync).

  **QA Scenarios**:
  ```
  Scenario: Hot reload picks up new repo
    Tool: interactive_bash
    Preconditions: tracked-repos.yaml has only repo X; watcher running with onChange wired to syncToDb
    Steps:
      1. cat >> tracked-repos.yaml <<EOF
         - repo_id: 9999999
           owner: my-private-org
           name: new-repo
         EOF
      2. sleep 2
      3. bun -e 'import {open} from "./apps/backend/src/db/connection"; console.log(open().prepare("SELECT name FROM repository WHERE active=1 ORDER BY name").all().map(r=>r.name).join(","))'
    Expected Result: step 3 prints "<old repo name>,new-repo"
    Evidence: .omo/evidence/task-17-hotreload.txt

  Scenario: Invalid YAML preserved last good
    Tool: Bash
    Preconditions: watcher running, valid config loaded
    Steps:
      1. echo "not: valid: yaml: at: all:" > tracked-repos.yaml
      2. sleep 2
      3. tail -n 5 apps/backend/logs/app.log | grep "yaml_parse_error"
      4. bun -e '...' to assert active repos unchanged
    Expected Result: log line present; active repo set matches last-good config
    Evidence: .omo/evidence/task-17-bad-yaml.txt

  Scenario: Reload does not trigger reconciliation
    Tool: Bash
    Preconditions: watcher running; spy on reconcileAll
    Steps:
      1. Edit tracked-repos.yaml (add then remove a repo)
      2. Confirm spy count for reconcileAll = 0
    Expected Result: zero reconciliation calls; only syncToDb runs
    Evidence: .omo/evidence/task-17-no-reconcile.txt
  ```

  **Commit**: YES — `feat(config): hot-reload watcher for tracked-repos`.

- [ ] 18. Argon2id token store + bin/token CLI

  **What to do**:
  - Create `src/auth/token-store.ts` exporting `issueToken(db, label): { token_id, token_plaintext }` (plaintext returned ONCE, never stored), `verifyToken(db, plaintext): Promise<ApiToken | null>`, `revokeToken(db, token_id)`.
  - Token format: `gpt_<32-byte-random-base64url>`. Hash with `argon2.hash` using OWASP-recommended params: `type=argon2id, memoryCost=19456 (19 MiB), timeCost=2, parallelism=1`.
  - On verify: scan `api_token` rows, `argon2.verify` against each hash until match (small N expected; document trade-off). Update `last_used_at`.
  - Create `bin/token`:
    - `bun run token issue --label "ui"` → prints token plaintext + token_id.
    - `bun run token list` → prints token_id, label, created_at, last_used_at.
    - `bun run token revoke <token_id>`.

  **Must NOT do**:
  - Do NOT store the plaintext token anywhere after issuance.
  - Do NOT log the plaintext token.
  - Do NOT use bcrypt, scrypt, or PBKDF2 (argon2id is the locked choice).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — security-critical CLI + crypto.

  **Parallelization**: Wave 4.
  - **Blocks**: 19, 22
  - **Blocked By**: 6, 7

  **References**:
  - OWASP argon2id params: `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id`

  **Acceptance Criteria**:
  - [ ] Issued plaintext verifies via `verifyToken`.
  - [ ] Wrong plaintext → `null`.
  - [ ] Revoked token → `null`.
  - [ ] `argon2.hash` parameters present in stored hash string (`$argon2id$v=19$m=19456,t=2,p=1$...`).
  - [ ] `bin/token issue` output is the only place the plaintext appears.

  **QA Scenarios**:
  ```
  Scenario: Issue + verify + revoke cycle
    Tool: Bash
    Preconditions: DB migrated
    Steps:
      1. PLAINTEXT=$(bun run token issue --label test | awk '/^Token:/ {print $2}')
      2. bun -e 'import {verifyToken} from "./apps/backend/src/auth/token-store"; import {open} from "./apps/backend/src/db/connection"; console.log((await verifyToken(open(), process.argv[1]))?.label)' "$PLAINTEXT"
      3. ID=$(bun run token list | awk '/test/ {print $1}')
      4. bun run token revoke "$ID"
      5. bun -e '...verifyToken...' "$PLAINTEXT" (should print null)
    Expected Result: step 2 prints "test"; step 5 prints "null"
    Evidence: .omo/evidence/task-18-token-cycle.txt

  Scenario: Plaintext never logged
    Tool: Bash
    Preconditions: token issued
    Steps:
      1. grep -F "$PLAINTEXT" logs/app.log || echo CLEAN
    Expected Result: CLEAN
    Evidence: .omo/evidence/task-18-no-leak.txt
  ```

  **Commit**: YES — `feat(auth): argon2id token store + cli`.

- [ ] 19. Auth middleware

  **What to do**:
  - Create `src/server/auth.ts` exporting `requireBearer(db): (req: Request) => Promise<ApiToken | Response>`.
  - Extract `Authorization` header → must start with `Bearer `.
  - Verify via T18 `verifyToken`. On miss: return 401 `Response` with `{error: "unauthorized"}` (no detail).
  - On hit: return the `ApiToken` row.

  **Must NOT do**:
  - Do NOT distinguish "missing header" from "wrong token" in the response (timing/error parity).
  - Do NOT log the token plaintext.

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**: Wave 4.
  - **Blocks**: 20
  - **Blocked By**: 18

  **Acceptance Criteria**:
  - [ ] Missing header → 401.
  - [ ] Wrong token → 401.
  - [ ] Valid token → returns `ApiToken` object.

  **QA Scenarios**:
  ```
  Scenario: All auth failure modes return 401
    Tool: Bash
    Preconditions: server module loadable (unit test scope)
    Steps:
      1. bun test src/server/auth.test.ts --reporter=tap
    Expected Result: 3 cases pass: missing, wrong, valid
    Evidence: .omo/evidence/task-19-auth.txt
  ```

  **Commit**: YES — `feat(auth): bearer middleware`.

- [ ] 20. Read API HTTP server (4 routes, both lifecycles)

  **What to do**:
  - Create `apps/backend/src/server/read-api.ts` exporting `startReadApiServer(opts): Server`.
  - `Bun.serve({ hostname: '127.0.0.1', port: 8788, fetch })`.
  - Routes:
    - `GET /api/health` → 200 `{ok: true}` (no auth).
    - `GET /api/prs?state=open|closed|all&author=<id|login>&repo_id=<id>&limit=<n>` → auth required.
      - Default `state=all` if omitted (web app filters).
      - Default `limit=200`, max `1000`.
      - Query DB:
        ```sql
        SELECT pr.*, r.owner_login, r.name AS repo_name,
               author.login AS author_login, author.avatar_url AS author_avatar_url
        FROM pull_request pr
        JOIN repository r ON pr.repo_id = r.repo_id
        JOIN person author ON pr.author_user_id = author.user_id
        WHERE r.active = 1
          AND (?1 = 'all' OR pr.state = ?1)
          AND (?2 IS NULL OR pr.author_user_id = ?2 OR author.login = ?3)
          AND (?4 IS NULL OR pr.repo_id = ?4)
        ORDER BY pr.updated_at DESC
        LIMIT ?5
        ```
    - `GET /api/prs/:id` → auth required. Return PR detail (joined with `repository` and `person`) + array of `review` rows (each joined with reviewer `person`).
    - `GET /api/repos` → auth required. Return `repository WHERE active=1` with counts: `SELECT r.*, COUNT(pr.github_pr_id) AS pr_count, SUM(CASE WHEN pr.state='open' THEN 1 ELSE 0 END) AS open_count FROM repository r LEFT JOIN pull_request pr ON pr.repo_id = r.repo_id WHERE r.active=1 GROUP BY r.repo_id`.
    - Other routes/methods → 404.
  - Response shape: stable JSON, snake_case keys matching DB columns; types defined in `@repo/types/api`.

  **Must NOT do**:
  - Do NOT bind `0.0.0.0`.
  - Do NOT include any field beyond the schema columns (no synthesized PR titles, no embedded markdown).
  - Do NOT call GitHub REST on this path.
  - Do NOT expose a `tracked-users` endpoint — there is no user subset to advertise.
  - Do NOT include rows from `active=0` repos (the soft-disable boundary is enforced server-side).
  - Do NOT support pagination cursors in v1 (`limit` cap is sufficient for the web app's initial use; document the bound).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`.

  **Parallelization**: Wave 4.
  - **Blocks**: 22
  - **Blocked By**: 7, 19, 21

  **Acceptance Criteria**:
  - [ ] `lsof -iTCP:8788 -sTCP:LISTEN` shows 127.0.0.1 only.
  - [ ] `curl http://0.0.0.0:8788/api/health` refused; `curl http://127.0.0.1:8788/api/health` returns 200.
  - [ ] Without bearer: 401 on `/api/prs`, `/api/prs/:id`, `/api/repos`.
  - [ ] With bearer + `state=closed`: returns only closed PRs.
  - [ ] With bearer + `state=all`: returns union; PRs from soft-disabled repos excluded.
  - [ ] With bearer + `author` filter (id or login): returns matching PRs only.
  - [ ] PR detail includes `reviews` array joined with reviewer `person` info.
  - [ ] `/api/repos` returns `pr_count` and `open_count` per active repo.

  **QA Scenarios**:
  ```
  Scenario: state=closed returns only closed PRs
    Tool: Bash
    Preconditions: DB seeded with 3 open + 2 closed PRs
    Steps:
      1. curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8788/api/prs?state=closed" | jq 'length, [.[].state] | unique'
    Expected Result: 2, then ["closed"]
    Evidence: .omo/evidence/task-20-closed.txt

  Scenario: Author filter works (by login)
    Tool: Bash
    Preconditions: DB has 2 PRs by alice, 1 by bob
    Steps:
      1. curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8788/api/prs?author=alice&state=all" | jq 'length'
    Expected Result: 2
    Evidence: .omo/evidence/task-20-author-filter.txt

  Scenario: Soft-disabled repo excluded
    Tool: Bash
    Preconditions: repo Y has 5 PRs; set Y.active=0
    Steps:
      1. curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8788/api/prs?state=all&repo_id=<Y>" | jq 'length'
    Expected Result: 0
    Evidence: .omo/evidence/task-20-disabled-repo.txt

  Scenario: Loopback only
    Tool: Bash
    Preconditions: server up
    Steps:
      1. lsof -iTCP:8788 -sTCP:LISTEN -P -n | grep -E "127\\.0\\.0\\.1:8788"
      2. curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 2 "http://$(ipconfig getifaddr en0):8788/api/health" || echo REFUSED
    Expected Result: step 1 matches; step 2 prints REFUSED or timeout
    Evidence: .omo/evidence/task-20-loopback.txt

  Scenario: Detail includes reviews with reviewer info
    Tool: Bash
    Preconditions: PR #42 with 2 reviews from 2 distinct reviewers
    Steps:
      1. curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8788/api/prs/42" | jq '.reviews | length, [.[].reviewer.login] | unique | length'
    Expected Result: 2, 2
    Evidence: .omo/evidence/task-20-detail.txt

  Scenario: /api/repos returns counts
    Tool: Bash
    Preconditions: repo X active with 3 open + 1 closed PR
    Steps:
      1. curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8788/api/repos" | jq '.[] | select(.repo_id==<X>) | {pr_count, open_count}'
    Expected Result: {"pr_count":4,"open_count":3}
    Evidence: .omo/evidence/task-20-repos.txt
  ```

  **Commit**: YES — `feat(server): read api with open/closed/all lifecycle`.

- [ ] 21. Privacy-allowlist logger

  **What to do**:
  - Create `src/logging/index.ts` exporting `log(level, msg, fields)`.
  - **Field allowlist** (hard-coded constant): `['event', 'action', 'delivery_id', 'status', 'duration_ms', 'outcome', 'error_class', 'repo_id', 'token_id', 'reason_code']`.
  - Any field NOT in allowlist is dropped silently (do not even log the key name).
  - Output: JSONL to `logs/app.log` only (`Bun.file().writer()` with append).
  - Rotate via external tool (newsyslog/logrotate); just append.
  - On startup, log a single line `{event: 'startup', binding_check: 'loopback'}` after both servers bound.

  **Must NOT do**:
  - Do NOT log: `login`, `title`, `body`, `org`, `repo_name`, `owner_login`, `head_sha`, `html_url`, `email`, any payload subfield.
  - Do NOT write to stdout/stderr by default (configurable via `LOG_STDERR=1` for dev only).
  - Do NOT add a network sink. EVER. No HTTP/syslog/UDP.

  **Recommended Agent Profile**:
  - **Category**: `quick`.

  **Parallelization**: Wave 4.
  - **Blocks**: 13, 20, 22
  - **Blocked By**: 1

  **Acceptance Criteria**:
  - [ ] Logging a disallowed field is silently dropped.
  - [ ] `logs/app.log` is JSONL.
  - [ ] After any QA run, `grep -E "(login|title|body|html_url)" logs/app.log` returns no matches.
  - [ ] No imports of any HTTP/network client in `src/logging/`.

  **QA Scenarios**:
  ```
  Scenario: Allowlist filter
    Tool: Bash
    Preconditions: logger module loaded
    Steps:
      1. bun test src/logging/index.test.ts -t "drops non-allowlisted field"
    Expected Result: test asserts log output contains 'event' but not 'login' even when both passed
    Evidence: .omo/evidence/task-21-allowlist.txt

  Scenario: No network sinks
    Tool: Bash
    Preconditions: src/logging/ committed
    Steps:
      1. grep -rn "fetch\|http\.request\|net\.createConnection\|dgram" src/logging/ || echo CLEAN
    Expected Result: CLEAN
    Evidence: .omo/evidence/task-21-no-network.txt
  ```

  **Commit**: YES — `feat(logging): allowlist logger`.

- [ ] 22. Process entrypoint + signal handling

  **What to do**:
  - Create `apps/backend/src/index.ts` as the main entrypoint.
  - Sequence on boot:
    1. Load `.env.local` (Bun auto-loads from monorepo root). Assert required keys present: `PR_TRACKER_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_ORG`. Missing → exit 1 with clear message. `GITHUB_RECONCILE_TOKEN` is **optional** (reconciliation degrades to warn-and-skip per T15).
    2. `db = open()` then `selfTest()` (T7) — fails loud if SQLCipher binding broken.
    3. `loadTrackedRepos(<root>/tracked-repos.yaml)` (T16) and `syncToDb`. Missing or invalid YAML on boot → exit 1.
    4. `watchTrackedRepos` (T17) wires hot-reload.
    5. `client = makeClient(...)` (T14) (only if token set) and `reconcileAll(db, client, getActiveRepos(db))` (T15). Log the report. Do NOT block startup if reconciliation fails — log and continue (drift will be picked up next start).
    6. `startWebhookServer` (T13) and `startReadApiServer` (T20). Log one `{event:'startup', binding_check:'loopback'}` line after both bound.
  - Signal handling: `SIGTERM`, `SIGINT` → stop both servers, stop watcher, close DB, exit 0 within 5s.
  - Crash handling: uncaughtException + unhandledRejection → log `{event:'crash', error_class}` and exit 1 (let launchd/systemd-user restart).

  **Must NOT do**:
  - Do NOT start cloudflared from inside this process (sidecar only).
  - Do NOT swallow startup errors.
  - Do NOT continue if `PR_TRACKER_KEY` is unset (the DB cannot open).

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — orchestration with strict order and signal correctness.

  **Parallelization**: Wave 4 final.
  - **Blocks**: 23, 25, F1-F4
  - **Blocked By**: 13, 15, 17, 20, 21, 3

  **Acceptance Criteria**:
  - [ ] Boots in < 3s on a small DB.
  - [ ] Missing env var → exits 1 with named error within 200ms.
  - [ ] SIGTERM → both servers stop, DB closes, exit 0 within 5s.
  - [ ] After boot, `logs/app.log` contains exactly one `event=startup` line.

  **QA Scenarios**:
  ```
  Scenario: Clean boot + graceful shutdown
    Tool: interactive_bash
    Preconditions: .env.local complete, DB migrated
    Steps:
      1. Pane A: bun run start
      2. Wait for "event":"startup" in logs/app.log
      3. Pane B: kill -TERM $(pgrep -f "bun.*src/index")
      4. Pane A: observe exit code 0 within 5s
    Expected Result: startup line present, exit 0 within 5s, no orphan listeners on 8787/8788
    Evidence: .omo/evidence/task-22-boot-shutdown.txt

  Scenario: Missing key fails loud
    Tool: Bash
    Preconditions: unset PR_TRACKER_KEY
    Steps:
      1. PR_TRACKER_KEY= bun run start; echo exit=$?
    Expected Result: stderr/log mentions missing key; exit=1
    Evidence: .omo/evidence/task-22-missing-key.txt
  ```

  **Commit**: YES — `feat(app): entrypoint and signal handling`.

- [ ] 23. Inline write-path bench

  **What to do**:
  - Create `bin/bench-webhook.ts` that:
    - Boots the webhook server in-process (no cloudflared).
    - Pre-seeds DB with 1 `person` row (PR author), 1 `repository` row with `active=1`.
    - Generates 1000 synthetic `pull_request.synchronize` payloads (varying `github_pr_id`).
    - Signs each, POSTs to 127.0.0.1:8787/webhook via `fetch`, measures latency.
    - Reports p50, p95, p99, max in ms.
    - Exits 0 if p99 < 500ms, else exit 1.
  - Wire as `bun run bench:webhook` script.

  **Must NOT do**:
  - Do NOT remove the `pull_request_review` handler from the dispatch path (bench measures the real production path).
  - Do NOT mock DB writes (must use real SQLCipher).

  **Recommended Agent Profile**:
  - **Category**: `deep` — bench design and threshold defense.

  **Parallelization**: Wave 5.
  - **Blocks**: F1, F2
  - **Blocked By**: 22, 10, 13

  **Acceptance Criteria**:
  - [ ] Bench runs to completion, prints p50/p95/p99/max.
  - [ ] p99 < 500ms.
  - [ ] If p99 ≥ 500ms, exit 1 and emit a `{event: 'bench_fail'}` log line.

  **QA Scenarios**:
  ```
  Scenario: Bench passes threshold
    Tool: Bash
    Preconditions: all prior tasks landed
    Steps:
      1. bun run bench:webhook
    Expected Result: stdout contains "p99=<NNN>ms" with NNN < 500; exit=0
    Evidence: .omo/evidence/task-23-bench.txt
  ```

  **Commit**: YES — `feat(bench): inline write-path harness`.

- [ ] 24. CI smoke test for SQLCipher binding under Bun

  **What to do**:
  - Create `.github/workflows/ci.yml` (or `scripts/ci-smoke.sh` if no CI is wired yet — user is local-only) with:
    - `bun install` (from monorepo root; postinstall rebuilds the SQLCipher binding)
    - `bun --filter @repo/backend run bin/spike-sqlcipher.ts` (T2 script, exits 0 only on success)
    - `bun turbo typecheck`
    - `bun turbo test`
  - Document in `docs/runbook.md` that the smoke script MUST be re-run after any Bun upgrade.
  - Pin Bun version in `package.json` `engines` and `.bun-version` file.

  **Must NOT do**:
  - Do NOT add proprietary CI (CircleCI Inc., etc.) configs; user runs locally, just a script.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`.

  **Parallelization**: Wave 5.
  - **Blocks**: F2
  - **Blocked By**: 2, 7

  **Acceptance Criteria**:
  - [ ] `bash scripts/ci-smoke.sh` exits 0 on a fresh clone.
  - [ ] Script fails if SQLCipher binding fails to load.
  - [ ] `.bun-version` matches `engines.bun` minimum.

  **QA Scenarios**:
  ```
  Scenario: CI smoke green on clean checkout
    Tool: Bash
    Preconditions: fresh clone in /tmp/clone
    Steps:
      1. cd /tmp/clone && bash scripts/ci-smoke.sh; echo exit=$?
    Expected Result: exit=0; stdout shows each step pass
    Evidence: .omo/evidence/task-24-ci-smoke.txt
  ```

  **Commit**: YES — `chore(ci): sqlcipher binding smoke`.

- [ ] 25. Operator runbook + README quickstart + deferred-deployment notes

  **What to do**:
  - Create root `README.md` with:
    - 30-second pitch + monorepo layout (`apps/backend`, `packages/types`).
    - Quickstart: install Bun, `bun install` at root, copy `.env.local.example` → `.env.local`, generate key (`openssl rand -hex 32`), generate webhook secret, create cloudflared tunnel, `bun --filter @repo/backend run migrate`, `bun --filter @repo/backend run start`.
    - How to populate `tracked-repos.yaml` (find `repo_id` via `gh api /repos/{owner}/{name} -q .id`).
    - How to register the **org-level** webhook in GitHub: org settings → webhooks → add → URL = cloudflared public URL + `/webhook`, secret = `GITHUB_WEBHOOK_SECRET`, events = `pull_request`, `pull_request_review`, `repository`.
    - Architecture diagram (ASCII) showing webhook flow, read flow, and trust boundaries (loopback line clearly marked).
  - Create `docs/runbook.md` with:
    - **Key rotation**: stop service → `bin/rekey` → start.
    - **Webhook secret rotation**: update GitHub UI → update `.env.local` → restart (in this order).
    - **Token rotation**: `bun --filter @repo/backend run token revoke <id>` + `... token issue --label new`.
    - **Adding/removing tracked repos**: edit `tracked-repos.yaml`; watcher hot-reloads within 2s; PRs from removed repos are excluded from the read API but retained in DB for history.
    - **Bun upgrade**: rerun `scripts/ci-smoke.sh` first.
    - **DB corruption recovery**: stop, move `apps/backend/data/prs.db`, start (cold start reconciliation rebuilds PRs per `state=all`; closed-PR history beyond 90 days lost on first reconciliation — that's accepted).
    - **Investigating "file is not a database"**: usually wrong key.
    - **What happens during downtime > 7 days**: events that fired and were dropped by GitHub's redelivery window are lost; reconciliation on next start recovers current state but intermediate transitions are not reconstructible.
    - **Pruning closed PRs**: optional `bun --filter @repo/backend run prune --older-than 365d` is a future task; not in v1.
  - Create `docs/encryption.md` documenting the SQLCipher open sequence and rekey runbook (T7).
  - **NEW**: Create `docs/deployment-deferred.md` capturing the round-2 decision tree for when the user revisits hosting:
    - **Option A — Local-first, Vercel hosts only the web app**: trust boundary identical to v1; backend reachable from Vercel via Tailscale / WireGuard / cloudflared with auth. Zero backend changes. Privacy guarantee fully held.
    - **Option C — Backend on stateful host (Fly.io / Railway / Render) + web app on Vercel**: backend keeps SQLCipher + native binding + persistent disk. Plan changes: drop loopback bind in favor of public HTTPS, add origin allowlist, terminate TLS at the platform edge, rotate webhook tunnel for the new public URL. Privacy: data lives on operator's hosted account.
    - **Option B — Vercel-hosted backend**: requires rewriting storage (Postgres on Neon / Supabase / Turso) with `pgcrypto` for sensitive columns, switching to Node runtime (`bun:sqlite` and the SQLCipher binding cannot run in Vercel Functions), abandoning `fs.watch` for config (move to env-driven or a `/api/admin/reload` endpoint). Privacy: data hosted by a third-party DB provider; column-level encryption mitigates but does not eliminate exposure. Estimated rewrite: 30–40% of the codebase.
    - **Decision criteria** the user should evaluate later: (1) acceptable data-hosting boundary, (2) need for SSE/WebSocket push to web app (rules out Vercel Functions for backend), (3) operational appetite for managing a stateful host, (4) compliance / data-residency rules.

  **Must NOT do**:
  - Do NOT include any real secrets/keys in docs.
  - Do NOT recommend external telemetry, error reporting, or "monitoring services".
  - Do NOT commit a `vercel.json`, `fly.toml`, or any deployment manifest — the deferred-deployment doc is text only.

  **Recommended Agent Profile**:
  - **Category**: `writing`.

  **Parallelization**: Wave 5.
  - **Blocks**: F1
  - **Blocked By**: 22

  **Acceptance Criteria**:
  - [ ] README quickstart followed verbatim leads to a running service in < 10 minutes (validated by F3 manual QA).
  - [ ] README documents org-level webhook setup (URL, events, secret).
  - [ ] Runbook covers all 8 operator scenarios listed above.
  - [ ] `docs/deployment-deferred.md` documents options A, B, C with explicit trade-offs.
  - [ ] No real secrets present (grep for 64-hex blobs and bearer tokens).
  - [ ] No deployment manifests committed.

  **QA Scenarios**:
  ```
  Scenario: Runbook coverage
    Tool: Bash
    Preconditions: docs committed
    Steps:
      1. for h in "Key rotation" "Webhook secret rotation" "Token rotation" "tracked repos" "Bun upgrade" "DB corruption" "not a database" "downtime"; do grep -qi "$h" docs/runbook.md || echo MISSING:$h; done
    Expected Result: no MISSING lines printed
    Evidence: .omo/evidence/task-25-runbook.txt

  Scenario: Deferred-deployment doc covers all three options
    Tool: Bash
    Preconditions: docs committed
    Steps:
      1. for opt in "Option A" "Option B" "Option C"; do grep -q "$opt" docs/deployment-deferred.md || echo MISSING:$opt; done
    Expected Result: no MISSING lines printed
    Evidence: .omo/evidence/task-25-deferred.txt

  Scenario: No deployment manifests present
    Tool: Bash
    Preconditions: scaffolding committed
    Steps:
      1. find . -name 'vercel.json' -o -name 'fly.toml' -o -name 'render.yaml' -o -name 'railway.json' -not -path './node_modules/*' | head -1 || echo CLEAN
    Expected Result: CLEAN
    Evidence: .omo/evidence/task-25-no-deploy.txt
  ```

  **Commit**: YES — `docs: readme, runbook, deferred-deployment notes`.

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to the user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read this plan end-to-end. For each "Must Have": verify implementation exists (read file, curl endpoint, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Verify webhook event list is exactly the 4 locked events with named actions only. Verify SQLCipher binding pinned at `12.10.0`. Verify both servers bind 127.0.0.1 only. Verify allowlist logger has no payload/login/title fields. Verify ordering fence in `pull_request` handler. Verify ghost user (id 10137) runtime guard exists in the handler (drops NEW events with no existing row). Verify repo allowlist enforced (events for repos with `active=0` or missing are `'ignored'`). Verify monorepo layout (`apps/backend`, `packages/types`) and that `@repo/types` is importable cross-workspace. Verify no deployment manifests (`vercel.json`/`fly.toml`/etc.) committed. Check evidence files exist in `.omo/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run the full quality gate: `bun turbo typecheck`, `bun turbo check` (Biome lint+format), `bun turbo test`, `bun --filter @repo/backend run bench:webhook`. ALL must exit 0. Biome's `noExplicitAny`, `noNonNullAssertion`, `noConsole`, `noFloatingPromises`, `useAwait`, `noBarrelFile`, `noReExportAll`, `useImportType` enforce most slop patterns directly — review focuses on what Biome can't catch: AI-slop tells (excessive comments, over-abstraction, generic names like data/result/item/temp), security-critical correctness (constant-time compare in HMAC verifier — no `===` on signature), and parameter audit (argon2id memoryCost/timeCost/parallelism meet OWASP recommendations). Also verify: no `// biome-ignore` directives outside the single sanctioned one in `packages/types/src/index.ts` (T6); no `tsconfig.base.json` overrides relaxing the strict cluster in any workspace; `@biomejs/biome` still pinned to `2.4.13` exact; `tsconfig.base.json` still has all 11 strict-cluster flags present (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, etc.).
  Output: `Typecheck [PASS/FAIL] | Biome [PASS/FAIL] | Tests [N pass/N fail] | Bench p99 [Nms] | Slop [N clean/N issues] | Biome-ignores [N expected/N found] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state (`rm -rf apps/backend/data/ apps/backend/logs/`). Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence to `.omo/evidence/final-qa/`. Test cross-task integration: (a) send 3 webhook events for the same PR in reverse `updated_at` order → final state matches latest, (b) add a repo entry to `tracked-repos.yaml` → within 2s, GET /api/repos includes it (with `pr_count`/`open_count` initially 0), (c) curl 0.0.0.0 on both ports → both refused, (d) `sqlite3 apps/backend/data/prs.db` without key → reports "file is not a database", (e) POST a `pull_request.opened` webhook for a repo NOT in `tracked-repos.yaml` → delivery_log outcome is `'ignored'` and no `pull_request` row inserted, (f) POST a `pull_request.closed` webhook with `merged_at` populated → row has `state='closed'` and non-null `merged_at`, then GET /api/prs?state=closed includes it. Test edge cases: missing `X-Hub-Signature-256`, wrong signature, duplicate delivery, ghost author payload (id 10137) with no existing row.
  Output: `Scenarios [N/N pass] | Integration [6/6] | Edge Cases [N tested/N pass] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (`git log`/`git diff`). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance per task. Detect cross-task contamination: Task N touching Task M's files. Verify webhook event list in code matches the 4 locked events. Verify no per-row AES-GCM crept back in. Verify no external HTTP clients beyond Octokit-to-GitHub. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- One commit per task. Conventional Commits.
- Format: `type(scope): description` where scope matches the module touched (e.g. `feat(webhook): hmac verifier`, `chore(db): schema migrations`).
- Pre-commit: `bun turbo typecheck && bun --filter @repo/backend test --bail`
- No squashing within a wave; reviewers (F1-F4) read per-task diffs.

---

## Success Criteria

### Final Checklist
- [ ] All "Must Have" items present and verified
- [ ] All "Must NOT Have" items absent (verified by F1 audit)
- [ ] `bun test` green
- [ ] `bun run bench:webhook` reports p99 < 500ms
- [ ] Both HTTP servers bound to 127.0.0.1 only (verified by `lsof`)
- [ ] SQLCipher DB unreadable without key
- [ ] No external telemetry endpoints in code (verified by grep)
- [ ] No payload/login/title strings in `logs/app.log` after a full QA run
- [ ] Reconciliation aligns DB to GitHub on every cold start
- [ ] Config hot-reload reflected within 2s
- [ ] F1, F2, F3, F4 all APPROVE
- [ ] User explicit "okay" received
