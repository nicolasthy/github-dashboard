# Runbook — github-pr-tracker

Operational notes for the single-host deployment. This is a stub — sections
will be filled in as each component lands. The structure below mirrors the
v1 architecture: a Bun backend, a SQLCipher database, and a `cloudflared`
sidecar for inbound webhooks.

---

## Components at a glance

| Component | Port / location | Managed by |
|---|---|---|
| Webhook receiver (Bun) | `127.0.0.1:8787` | `launchd` / `systemd --user` |
| Read API (Bun) | `127.0.0.1:8788` | same process tree as webhook |
| SQLCipher database | `apps/backend/data/*.db` | backend process |
| Cloudflare Tunnel sidecar | `cloudflared` → 127.0.0.1:8787 | `launchd` / `systemd --user` (separate unit) |

The backend process and `cloudflared` are **separate units**. Restarting one
must NOT restart the other.

---

## Incident playbooks

### What to do if cloudflared is down > 7 days

**Symptom:** no webhook deliveries for an extended period; the GitHub webhook
delivery log shows consecutive failures past the 7-day mark.

**What is recoverable:**

- The *current* state of every tracked PR — author, head SHA, mergeable
  state, review decision — is reconstructible via REST reconciliation on the
  next backend start. Run the reconciliation job (`bun src/jobs/reconcile.ts`,
  to be implemented) which walks `tracked-repos.yaml` and upserts each open
  PR.

**What is NOT recoverable:**

- **Intermediate transitions** during the outage window. If a PR went
  `opened → reviewed → changes_requested → reviewed → merged` while the
  tunnel was down, only the terminal state (`merged`) is observable from
  the REST API. Counts, histograms, or time-series derived from per-event
  rows will be missing those events permanently.
- **Deliveries past the GitHub API redelivery window.** GitHub keeps failed
  deliveries replayable for **3 days via the UI** and **30 days via the REST
  API**. After 30 days the failed deliveries are purged on GitHub's side and
  cannot be replayed even manually. v1 does NOT call the redelivery API, so
  in practice the moment a delivery fails it is gone for our purposes.

**Recovery procedure:**

1. Investigate why `cloudflared` was down for so long
   (check `journalctl --user -u cloudflared` or
   `log show --predicate 'subsystem == "com.cloudflare.cloudflared"' --last 7d`).
2. Restart `cloudflared` (`systemctl --user restart cloudflared` or
   `launchctl kickstart -k gui/$UID/com.cloudflare.cloudflared`).
3. Verify the tunnel is healthy by triggering a GitHub webhook ping and
   confirming the spike log / production handler receives it.
4. Run the REST reconciliation job to refresh the *current* state of every
   tracked PR. Accept that intermediate transitions during the outage are
   lost.
5. Open a follow-up issue if the loss rate observed during the outage
   exceeds the tolerance documented in `docs/spikes/cloudflared.md` — this
   is the trigger to revisit the v2 decision on programmatic GitHub
   redelivery (which extends recoverability to 30 days but adds operational
   complexity).

**Why we don't try harder in v1:**

See `docs/spikes/cloudflared.md` (the resilience spike). The expected loss
rate during a short outage is 5/10 deliveries over a 90 s window, and the
single-host deployment target makes a more elaborate retry pipeline
unjustified for v1.

---

## Sections to fill in later

- [ ] Restoring from backup (encrypted SQLCipher dump strategy)
- [ ] Rotating the SQLCipher database key
- [ ] Rotating the GitHub webhook secret
- [ ] Rotating the Cloudflare Tunnel credentials
- [ ] Handling a ghost user (id=10137) impersonation event
- [ ] What to do if the backend process is wedged (Bun event loop stalled)
- [ ] What to do if `tracked-repos.yaml` and the repo list on GitHub diverge
