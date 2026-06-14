# github-pr-tracker

A local, privacy-preserving backend that ingests GitHub webhooks at the org level and serves all PRs (open + closed) in a configurable set of repositories over a loopback HTTP API. Encrypted at rest (v2), zero external telemetry.

---

## Architecture

```
                        ┌─────────────────────────────────────────────────────┐
                        │                  TRUST BOUNDARY                     │
                        │                  (loopback only)                    │
                        │                                                     │
  GitHub ──────────────►│ Cloudflare Tunnel                                   │
  (webhook events)      │      │                                              │
                        │      ▼                                              │
                        │ 127.0.0.1:8787/webhook                              │
                        │ (Webhook Server)                                    │
                        │      │                                              │
                        │      ▼                                              │
                        │ SQLite DB ◄──────────────────────────────────────── │
                        │ (bun:sqlite)                                        │
                        │      ▲                                              │
                        │      │                                              │
                        │ 127.0.0.1:8788/api                                  │
                        │ (Read API)                                          │
                        │      ▲                                              │
                        │      │                                              │
  Web App ─────────────►│ (local browser / dashboard)                         │
                        │                                                     │
                        └─────────────────────────────────────────────────────┘
```

Both servers bind `127.0.0.1` only. No data leaves the machine except through the Cloudflare Tunnel, which is inbound-only.

---

## Monorepo layout

```
github-dashboard/
├── apps/
│   └── backend/          # Bun HTTP servers, SQLite DB, webhook handlers
│       ├── bin/          # CLI tools (token management, spikes)
│       ├── src/          # Application source
│       │   ├── auth/     # Token store (argon2 hashing)
│       │   ├── config/   # tracked-repos.yaml watcher
│       │   ├── db/       # SQLite connection + migrations
│       │   ├── github/   # Octokit REST client
│       │   ├── handlers/ # Webhook event handlers
│       │   ├── reconcile/# Startup reconciliation job
│       │   ├── server/   # Webhook + Read API servers
│       │   └── webhook/  # Signature verification + dedup
│       └── data/         # SQLite DB files (gitignored)
├── packages/
│   └── types/            # Shared TypeScript types (@repo/types)
├── docs/                 # Operator documentation
│   ├── runbook.md        # Operator scenarios
│   ├── encryption.md     # SQLCipher / bun:sqlite decision
│   ├── deployment-deferred.md  # Round-2 hosting options
│   └── spikes/           # Research spikes (cloudflared, fswatch)
├── scripts/
│   └── ci-smoke.sh       # CI smoke test
├── tracked-repos.yaml    # Which repos to track
└── .env.local.example    # Environment variable template
```

---

## Quickstart

### Prerequisites

- macOS or Linux
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed and authenticated

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install dependencies

```bash
bun install
```

### 3. Configure environment

```bash
cp .env.local.example .env.local
```

Generate a webhook secret:

```bash
openssl rand -hex 32
```

Edit `.env.local` and set:

```bash
GITHUB_WEBHOOK_SECRET=<output from openssl above>
GITHUB_ORG=<your-org>
GITHUB_RECONCILE_TOKEN=<PAT with repo scope>   # optional, enables reconciliation on startup
```

The `GITHUB_RECONCILE_TOKEN` is a GitHub Personal Access Token with `repo` scope. It's used on startup to fetch current PR state for all tracked repos. Without it, the backend only processes incoming webhook events.

### 4. Create a Cloudflare Tunnel

```bash
cloudflared tunnel create github-pr-tracker
```

Follow the prompts to configure the tunnel to forward to `http://127.0.0.1:8787`. Note the public URL assigned to your tunnel (e.g. `https://github-pr-tracker.example.com`).

### 5. Run database migrations

```bash
bun --filter @repo/backend run migrate
```

### 6. Start the backend

```bash
bun --filter @repo/backend run start
```

The webhook server listens on `127.0.0.1:8787` and the read API on `127.0.0.1:8788`.

---

## Configuring tracked repositories

Edit `tracked-repos.yaml` at the repo root:

```yaml
repos:
  - owner: "your-org"
    name: "your-repo"
  - owner: "your-org"
    name: "another-repo"
```

The backend watches this file and hot-reloads within 2 seconds. No restart needed.

To find a repo's numeric ID (used internally):

```bash
gh api /repos/{owner}/{name} -q .id
```

---

## Registering the org-level webhook on GitHub

1. Go to your GitHub org settings: `https://github.com/organizations/<your-org>/settings/hooks`
2. Click **Add webhook**
3. Set **Payload URL** to your cloudflared public URL + `/webhook`:
   ```
   https://github-pr-tracker.example.com/webhook
   ```
4. Set **Content type** to `application/json`
5. Set **Secret** to the value of `GITHUB_WEBHOOK_SECRET` from your `.env.local`
6. Under **Which events would you like to trigger this webhook?**, select **Let me select individual events** and check:
   - `Pull requests`
   - `Pull request reviews`
   - `Repositories`
7. Ensure **Active** is checked
8. Click **Add webhook**

GitHub will send a ping event. The backend logs it and responds 200.

One org-level webhook covers all current and future repositories in the org. The backend filters events at runtime to only process repos listed in `tracked-repos.yaml`.

---

## Token management

The read API requires a bearer token. Manage tokens with the CLI:

```bash
# Issue a new token
bun --filter @repo/backend run token issue --label my-dashboard

# List tokens
bun --filter @repo/backend run token list

# Revoke a token
bun --filter @repo/backend run token revoke <id>
```

---

## Further reading

- `docs/runbook.md` — operator scenarios (key rotation, secret rotation, DB recovery, etc.)
- `docs/encryption.md` — SQLCipher / bun:sqlite decision and v2 upgrade path
- `docs/deployment-deferred.md` — options for hosting the backend beyond local-only
- `docs/spikes/cloudflared.md` — cloudflared resilience analysis
- `docs/spikes/fswatch.md` — file-watch implementation notes
