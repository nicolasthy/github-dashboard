# Runbook — github-pr-tracker

Operational notes for the single-host deployment. The v1 architecture: a Bun backend, a `bun:sqlite` database (SQLCipher deferred to v2), and a `cloudflared` sidecar for inbound webhooks.

---

## Components at a glance

| Component | Port / location | Managed by |
|---|---|---|
| Webhook receiver (Bun) | `127.0.0.1:8787` | `launchd` / `systemd --user` |
| Read API (Bun) | `127.0.0.1:8788` | same process tree as webhook |
| SQLite database | `apps/backend/data/prs.db` | backend process |
| Cloudflare Tunnel sidecar | `cloudflared` → 127.0.0.1:8787 | `launchd` / `systemd --user` (separate unit) |

The backend process and `cloudflared` are **separate units**. Restarting one must NOT restart the other.

**v1 encryption note**: The database uses `bun:sqlite` (plain SQLite). There is no application-level encryption key in v1. The DB file is protected by OS-level disk encryption (macOS FileVault / Linux LUKS). SQLCipher is deferred to v2. See `docs/encryption.md` for the full rationale.

---

## 1. Key rotation

**v1**: There is no database encryption key in v1. `bun:sqlite` does not use SQLCipher. This scenario does not apply until v2.

**v2 procedure** (when SQLCipher is added):

1. Stop the backend service.
2. Run the rekey utility:
   ```bash
   bun --filter @repo/backend run bin/rekey
   ```
   This script opens the DB with the old key, runs `PRAGMA rekey = x'<new_key>'`, and closes cleanly. It requires `PR_TRACKER_KEY_OLD` and `PR_TRACKER_KEY_NEW` in the environment.
3. Update `PR_TRACKER_KEY` in `.env.local` to the new value.
4. Start the backend service.
5. Verify the DB opens cleanly by checking the startup log for `db: open ok`.

**Why `journal_mode = DELETE` before rekey**: WAL mode must be switched back to DELETE before running `PRAGMA rekey`, then restored to WAL after. The `bin/rekey` script handles this automatically. Do not attempt a manual rekey without reading `docs/encryption.md` first.

---

## 2. Webhook secret rotation

The webhook secret authenticates GitHub's HMAC-SHA256 signature on every incoming payload. Rotating it requires updating both GitHub and the local config in the right order to avoid a gap where valid deliveries are rejected.

**Procedure**:

1. Generate a new secret:
   ```bash
   openssl rand -hex 32
   ```
2. Go to your org webhook settings on GitHub and update the secret to the new value. GitHub will start signing new deliveries with the new secret immediately.
3. Update `GITHUB_WEBHOOK_SECRET` in `.env.local` to the new value.
4. Restart the backend:
   ```bash
   # macOS launchd
   launchctl kickstart -k gui/$UID/com.github-pr-tracker.backend
   # Linux systemd --user
   systemctl --user restart github-pr-tracker-backend
   ```
5. Verify by triggering a GitHub webhook ping from the org settings page and confirming the backend logs `webhook: signature ok`.

**Order matters**: Update GitHub first, then `.env.local`, then restart. If you restart before updating GitHub, the backend will reject deliveries signed with the old secret during the window between restart and GitHub's update propagating.

---

## 3. Token rotation

The read API uses bearer tokens hashed with argon2. Tokens are managed via the `token` CLI.

**Procedure**:

1. Issue a replacement token before revoking the old one:
   ```bash
   bun --filter @repo/backend run token issue --label new
   ```
   Copy the printed token value — it is shown only once.

2. Update any clients (dashboard, scripts) to use the new token.

3. Revoke the old token by its ID:
   ```bash
   bun --filter @repo/backend run token list
   bun --filter @repo/backend run token revoke <id>
   ```

No restart is required. The token store is checked on each request.

---

## 4. Adding or removing tracked repos

Tracked repositories are configured in `tracked-repos.yaml` at the monorepo root.

**Adding a repo**:

```yaml
repos:
  - owner: "your-org"
    name: "new-repo"
```

The config watcher hot-reloads within 2 seconds. No restart needed. The backend will start processing webhook events for the new repo immediately. To backfill existing PRs, trigger a manual reconciliation (or restart the backend if `GITHUB_RECONCILE_TOKEN` is set — reconciliation runs on startup).

To find a repo's numeric ID:
```bash
gh api /repos/{owner}/{name} -q .id
```

**Removing a repo**:

Delete the entry from `tracked-repos.yaml`. The watcher hot-reloads within 2 seconds. PRs from the removed repo are **excluded from the read API** immediately but **retained in the database** for historical reference. They are not deleted. If you want to purge them, connect to the DB directly:

```bash
sqlite3 apps/backend/data/prs.db "DELETE FROM pull_requests WHERE repo_id = <id>;"
```

---

## 5. Bun upgrade

Bun upgrades can change runtime behavior, native module compatibility, and test runner semantics.

**Procedure**:

1. Update Bun:
   ```bash
   bun upgrade
   ```

2. Run the CI smoke test before restarting the production service:
   ```bash
   bash scripts/ci-smoke.sh
   ```
   This script runs the full test suite and any integration checks. If it exits non-zero, do not proceed.

3. Run the full test suite:
   ```bash
   bun turbo test
   ```

4. If all checks pass, restart the backend service.

5. Watch the startup logs for any new warnings or errors.

**SQLCipher note**: In v1, `bun:sqlite` is the only DB dependency. Bun upgrades that change `bun:sqlite` behavior (schema, pragma support) are the main risk. The `connection.test.ts` suite covers the open sequence.

---

## 6. DB corruption recovery

**Symptoms**: The backend fails to start, logs contain `SqliteError: database disk image is malformed` or similar, or the DB file is zero bytes.

**v1 note**: In v1 there is no encryption key. "File is not a database" errors are genuine corruption, not a key mismatch. See scenario 7 for that specific error.

**Procedure**:

1. Stop the backend service.

2. Move the corrupted DB out of the way:
   ```bash
   mv apps/backend/data/prs.db apps/backend/data/prs.db.corrupted-$(date +%Y%m%d%H%M%S)
   ```

3. Start the backend. It will create a fresh DB and run migrations automatically.

4. If `GITHUB_RECONCILE_TOKEN` is set, the reconciliation job runs on startup and rebuilds current PR state for all tracked repos by querying the GitHub REST API with `state=all`.

**What is recovered**: Current state of every open and recently-closed PR in tracked repos.

**What is lost**: Closed-PR history beyond the GitHub API's lookback window (approximately 90 days for `state=all` on large repos). Intermediate state transitions (e.g., a PR that was reviewed, had changes requested, then merged) are not reconstructible from the REST API alone. This loss is accepted in v1.

---

## 7. Investigating "file is not a database"

**Error**: `SqliteError: file is not a database` (SQLite error code `SQLITE_NOTADB`).

**In v1**: This error means the DB file is genuinely corrupted or is not a SQLite file. There is no encryption key in v1, so this is not a key mismatch. Common causes:

- The file was truncated (disk full, interrupted write).
- The file was replaced with a non-SQLite file.
- The file is a SQLCipher-encrypted DB from a test or migration attempt (if you ever ran the SQLCipher spike against the production path by mistake).

**In v2** (when SQLCipher is added): This error can also mean the wrong key was supplied. The `SELECT 1` probe in the open sequence surfaces it. Check `PR_TRACKER_KEY` in `.env.local` before assuming corruption.

**Procedure (v1)**:

1. Stop the backend service.

2. Inspect the file:
   ```bash
   file apps/backend/data/prs.db
   sqlite3 apps/backend/data/prs.db "PRAGMA integrity_check;"
   ```

3. If the file is not a valid SQLite DB, move it and restart (see scenario 6 above).

4. If `integrity_check` reports errors, the DB is corrupted. Move it and restart.

5. If the file looks valid but the error persists, check whether the file is actually a SQLCipher DB (from a spike run). A SQLCipher DB opened without a key will report `SQLITE_NOTADB` on the first query. Move it and restart.

---

## 8. What happens during downtime longer than 7 days

**Context**: GitHub retains failed webhook deliveries for redelivery via the UI for 3 days, and via the REST API for 30 days. v1 does not call the redelivery API.

**What is recoverable**:

- The *current* state of every tracked PR — author, head SHA, mergeable state, review decision — is reconstructible via REST reconciliation on the next backend start. The reconciliation job walks `tracked-repos.yaml` and upserts each PR using `state=all`.

**What is NOT recoverable**:

- **Intermediate transitions** during the outage window. If a PR went `opened → reviewed → changes_requested → reviewed → merged` while the tunnel was down, only the terminal state (`merged`) is observable from the REST API. Per-event rows for those transitions are permanently lost.
- **Deliveries past the GitHub redelivery window**. After 30 days, failed deliveries are purged on GitHub's side. v1 does not call the redelivery API, so in practice any delivery that failed is gone for our purposes the moment it fails.

**Recovery procedure**:

1. Investigate why `cloudflared` was down (check `journalctl --user -u cloudflared` or `log show --predicate 'subsystem == "com.cloudflare.cloudflared"' --last 7d`).
2. Restart `cloudflared`.
3. Verify the tunnel is healthy by triggering a GitHub webhook ping and confirming the backend receives it.
4. Restart the backend (or trigger reconciliation manually) to refresh current PR state.
5. Accept that intermediate transitions during the outage are lost.

**Why v1 doesn't try harder**: See `docs/spikes/cloudflared.md`. The expected loss rate during a short outage is acceptable for the single-host deployment target. Programmatic redelivery (which extends recoverability to 30 days) is a v2 consideration.

---

## Appendix: Service management commands

### macOS (launchd)

```bash
# Start
launchctl kickstart gui/$UID/com.github-pr-tracker.backend

# Stop
launchctl kill TERM gui/$UID/com.github-pr-tracker.backend

# Restart
launchctl kickstart -k gui/$UID/com.github-pr-tracker.backend

# Logs
log show --predicate 'subsystem == "com.github-pr-tracker"' --last 1h
```

### Linux (systemd --user)

```bash
# Start
systemctl --user start github-pr-tracker-backend

# Stop
systemctl --user stop github-pr-tracker-backend

# Restart
systemctl --user restart github-pr-tracker-backend

# Logs
journalctl --user -u github-pr-tracker-backend -f
```
