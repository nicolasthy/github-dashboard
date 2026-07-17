# Deployment Options — Deferred Decision

This document captures the round-2 hosting decision for the github-pr-tracker backend. v1 runs entirely on a single local machine. The options below are evaluated for when the operator wants to move the backend off their laptop or make the dashboard accessible to other team members.

No deployment manifests are committed alongside this document. The decision is deferred until the operator's requirements are clear.

---

## Option A — Local-first, Vercel hosts only the web app

**Summary**: The backend stays on the operator's machine. Only the web app (dashboard UI) moves to Vercel. The web app reaches the backend over a private tunnel.

**Architecture**:

```
  Browser (anywhere)
       │
       ▼
  Vercel (web app only)
       │
       │  Tailscale / WireGuard / cloudflared with auth
       ▼
  Operator's machine (backend + SQLite)
       │
       ▼
  127.0.0.1:8788/api (Read API)
```

**What changes from v1**: Nothing in the backend. The web app gains a configured base URL pointing to the private tunnel endpoint instead of localhost. The tunnel must require authentication (Cloudflare Access, Tailscale ACLs, or WireGuard peer auth) so the read API is not publicly reachable.

**Privacy**: The trust boundary is identical to v1. All PR data stays on the operator's machine. The web app on Vercel holds no data and makes no GitHub API calls.

**Operational notes**:
- The operator's machine must stay on and reachable for the dashboard to work.
- Tunnel credentials need rotation on the same schedule as the webhook tunnel (see runbook scenario 2).
- Zero backend code changes required.

**Best fit for**: Operators who want a shareable dashboard URL but are comfortable keeping the backend local. Strong privacy guarantee fully held.

---

## Option C — Backend on a stateful host (Fly.io / Railway / Render) + web app on Vercel

**Summary**: The backend moves to a hosted platform that supports persistent disk. SQLite stays as the database. The web app moves to Vercel and reaches the backend over HTTPS.

**Architecture**:

```
  Browser (anywhere)
       │
       ▼
  Vercel (web app)
       │
       │  HTTPS + bearer token
       ▼
  Fly.io / Railway / Render (backend)
       │
       ▼
  SQLite on persistent disk (platform volume)
       ▲
       │
  GitHub (webhooks over public HTTPS)
```

**What changes from v1**:

- Drop the loopback bind (`127.0.0.1`) in favor of `0.0.0.0` (or the platform's internal network interface).
- Add an origin allowlist to the read API so only the Vercel deployment can call it.
- TLS terminates at the platform edge — no self-managed certificates.
- The cloudflared webhook tunnel is replaced by the platform's public HTTPS URL registered directly in the GitHub org webhook settings.
- The `GITHUB_WEBHOOK_SECRET` and bearer tokens still apply; the rotation runbook (scenarios 2 and 3) is unchanged.

**Privacy**: PR data lives on the operator's hosted account at the chosen platform. The platform provider can access the disk. This is a weaker privacy guarantee than Option A but stronger than Option B (no third-party DB provider).

**Operational notes**:
- Persistent disk must be provisioned and mounted at `apps/backend/data/`.
- Platform restarts must not wipe the volume (check platform docs for volume persistence guarantees).
- WAL mode (`journal_mode = WAL`) is safe on a single-writer persistent volume.
- Estimated backend changes: small (bind address, origin header check). No storage rewrite.

**Best fit for**: Operators who want the backend always-on without keeping a laptop running, and are comfortable with data on a hosted platform.

---

## Option B — Vercel-hosted backend

**Summary**: Both the web app and the backend move to Vercel Functions. Storage moves to a managed Postgres or SQLite-compatible cloud DB.

**Architecture**:

```
  Browser (anywhere)
       │
       ▼
  Vercel (web app + API routes / Edge Functions)
       │
       ▼
  Neon / Supabase / Turso (managed DB)
       ▲
       │
  GitHub (webhooks to Vercel Function endpoint)
```

**What changes from v1**:

- **Storage rewrite**: `bun:sqlite` cannot run in Vercel Functions (no persistent filesystem, no native binaries in the Edge runtime). The DB layer must be rewritten to target Postgres (Neon, Supabase) or a serverless SQLite service (Turso). Schema migrations, query layer, and connection management all change.
- **Runtime swap**: The backend currently uses Bun-specific APIs (`bun:sqlite`, `Bun.serve`, `Bun.file`). Vercel Functions run on Node.js (or the Edge runtime). All Bun-specific imports must be replaced.
- **Config watcher removed**: `fs.watch` on `tracked-repos.yaml` cannot work in a serverless environment. Config must move to an environment variable, a DB table, or a Vercel KV store.
- **No SSE / WebSocket push**: Vercel Functions are stateless and short-lived. Long-lived connections for real-time push require a separate service (Pusher, Ably, Vercel's experimental streaming support).

**Privacy**: PR data is hosted by a third-party DB provider (Neon, Supabase, or Turso). The provider can access the data. This is the weakest privacy guarantee of the three options.

**Estimated rewrite scope**: 30-40% of the backend codebase (DB layer, server layer, config layer, all Bun-specific imports).

**Best fit for**: Operators who want zero infrastructure to manage and accept third-party data hosting. Not recommended if data residency or privacy is a concern.

---

## Decision criteria

Choose the option that satisfies all of the following:

1. **Acceptable data-hosting boundary**: Who can access the raw PR data? Option A keeps it on your machine. Option C puts it on your hosted account. Option B puts it with a DB provider.

2. **Need for SSE / WebSocket push to the web app**: If the dashboard needs real-time updates without polling, Option A or C (persistent backend process) is straightforward. Option B requires a third-party push service.

3. **Operational appetite for managing a stateful host**: Option A requires keeping a machine running. Option C requires provisioning and monitoring a hosted service. Option B is fully managed but requires the largest code change.

4. **Compliance and data-residency rules**: If PR data is subject to data-residency requirements (e.g., must stay in a specific region or jurisdiction), Option A gives the most control. Option C depends on the platform's region support. Option B depends on the DB provider's region support.

---

## Current status

**v1 is Option A by default** (backend local, no web app deployed). The decision to move to Option B or C is deferred until the operator has a concrete need (team access, always-on availability, or compliance requirement).
