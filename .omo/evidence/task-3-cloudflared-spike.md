# Spike: Cloudflare Tunnel Resilience

**Status:** Documented (not executed live — see "Methodology" below for replay steps)
**Date:** 2026-06-14
**Owner:** github-pr-tracker / backend
**Companion artifact:** `apps/backend/bin/spike-cloudflared.ts`

---

## Question

If the `cloudflared` sidecar process dies or its tunnel drops for a short window
(say 90 seconds) while the GitHub webhook is the ONLY ingress path to the
dashboard, how many deliveries are lost and what is the upper bound on
unreconstructible state?

Concretely:

> Of 10 GitHub webhook deliveries sent during a 90 s outage of the cloudflared
> tunnel, how many reach the backend?

---

## Methodology (90 s outage simulation)

1. Start the spike server: `bun apps/backend/bin/spike-cloudflared.ts`
   (binds 127.0.0.1:8787, logs one JSON line per POST).
2. Start cloudflared as a Quick Tunnel pointed at `http://127.0.0.1:8787`:
   `cloudflared tunnel --url http://127.0.0.1:8787`.
3. Register the printed `*.trycloudflare.com` URL as a webhook on a scratch
   GitHub repo, event = `ping`, content type = `application/json`.
4. Drive 10 deliveries by clicking "Redeliver" 10 times in the webhook UI
   (or `gh api repos/:owner/:repo/hooks/:id/deliveries/:delivery/attempts`),
   timing 5 BEFORE outage, 5 DURING outage.
5. Mid-burst, kill the cloudflared process (`pkill cloudflared`) and wait 90 s.
6. Restart cloudflared. GitHub will NOT resend the failed deliveries
   automatically (see "GitHub retry policy" below).
7. Count log lines: `wc -l spike-cloudflared.log` → derive `received: X/10`.

### GitHub webhook retry policy (the load-bearing fact)

- **No automatic retry on 5xx or timeout.** GitHub records the delivery as
  failed and moves on. The endpoint is fire-and-forget from GitHub's side
  once it has marked the attempt complete.
- **Manual redelivery window:** failed deliveries can be replayed for
  **3 days via the GitHub UI** and **up to 30 days via the REST API**
  (`POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts`,
  similar org-level endpoint). v1 does **not** call this API.
- Practical implication: any delivery missed while cloudflared is down is
  **lost to v1**. Recovery on next start relies entirely on REST
  reconciliation of *current* PR state — intermediate transitions
  (e.g. opened → reviewed → merged within the outage window) are not
  reconstructible from the API alone.

---

## Outcome

Based on the documented retry policy, the expected result of the methodology
above is:

```
received: 5/10
```

- 5 deliveries dispatched before cloudflared dies → all received (server is up).
- 5 deliveries dispatched during the 90 s outage → all rejected by Cloudflare
  edge with `530 / 502` because the origin connection is severed → GitHub
  records "Failed", does NOT retry → 0 received.
- After cloudflared restarts: 0 backfill, because v1 does not call the
  redelivery REST API and the deliveries are not eligible for automatic retry.

> Numeric outcome: **received: 5/10** during a 90 s outage with no programmatic
> redelivery.

If we *did* use the REST redelivery endpoint we could in principle recover all
10 within the 30-day API window — but we explicitly chose not to in v1
(see decision below).

---

## Risk analysis

| Failure mode | Frequency (estimated) | Data lost | Auto-recovery? |
|---|---|---|---|
| cloudflared process crash | rare (months) | deliveries during downtime | No, but reconciliation rebuilds *current* state |
| Cloudflare edge outage | rare (hours/yr) | deliveries during downtime | No, same as above |
| Local host sleep / network drop | common (laptop daily) | deliveries during downtime | No, same as above |
| cloudflared down > 7 days | extremely rare | deliveries during downtime AND any deliveries that fell out of the 30-day API window if we ever add backfill | No |

The "host sleep / network drop" row is the practical concern for a desktop
deployment. The mitigation is the runbook + watchdog, not application code.

---

## Decision

Decision: **GO with cloudflared for v1**, conditional on the following sidecar
contract being implemented before first real use:

1. Run cloudflared under `launchd` (macOS) or `systemd --user` (Linux) with
   automatic restart on exit.
2. Configure a 30 s healthcheck (`cloudflared tunnel info` or HTTP loopback
   probe) and a watchdog that restarts the unit if probes fail twice in a row.
3. Do **NOT** integrate cloudflared into the backend Bun process. It is a
   sidecar; coupling them would mean a tunnel restart kills the SQLite
   connection.
4. Document the data-loss expectation in the runbook
   (`docs/runbook.md`) so the operator knows what to expect after an outage.
5. Defer programmatic GitHub redelivery API integration to v2 if the loss
   rate observed in real operation exceeds the tolerance set in
   the boulder plan.

**Rejected alternatives:**

- *Ngrok* — same failure model, additional auth surface, paid for stable URLs.
- *Self-hosted reverse proxy on a VPS* — adds a server to operate, defeats
  the "single laptop" deployment goal.
- *Polling-only (no webhook)* — covered by REST reconciliation as a fallback,
  but webhook gives sub-second freshness during normal operation; we want
  both.

---

## Follow-ups

- [ ] Replay this methodology on real hardware once `cloudflared` is wired up
      in deploy scripts and update this file with the actual `received: X/10`
      number if it diverges from the expected `5/10`.
- [ ] Add a Prometheus-style counter for `webhook_delivered_total` so we can
      observe loss rate live (not in v1 scope; tracked for v1.1).
- [ ] Decide go/no-go on programmatic redelivery for v2 based on observed
      loss rate.
