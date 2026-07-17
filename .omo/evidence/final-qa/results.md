# Final QA Evidence — $(date)

## Environment
- Date: Sun Jun 14 2026
- Secret: qa-test-secret-88d2edca4aacd5aa
- DB: apps/backend/data/qa-test.db
- Server PID: 80408

## Scenario Results

### 1. HMAC Signature Verification
- Valid sig → **200** ✅
- Wrong sig (deadbeef) → **401** ✅

### 2. Loopback Binding
- Port 8787: `127.0.0.1:8787 (LISTEN)` ✅
- Port 8788: `127.0.0.1:8788 (LISTEN)` ✅

### 3. Read API Auth
- No bearer → **401** ✅
- /api/health (no auth) → **200** ✅

### 4. Token Issuance and Verification
- Token issued: `gpt_xy8M1MXYUOTEb_Yv8dMgQ-13lxGgu1gg5ZCd2q5s_Ns`
- ID: `tok_8f8241d607d33c34`, Label: `qa-test`
- API call with token → **200**, body: `[]` ✅

### 5. Biome Version
- Output: `Version: 2.4.13` ✅

### 6. Bench Threshold
- p50=0.1ms, p95=0.2ms, p99=0.5ms, max=7.1ms, non-2xx=0
- `PASS: p99=0.5ms < 500ms` ✅

### 7. No Banned Deps
- Output: `CLEAN` ✅

### 8. Runbook Coverage
- All headings found: Key rotation, Webhook secret rotation, Token rotation, tracked repos, Bun upgrade, DB corruption, not a database, downtime ✅

### 9. Deployment Doc Coverage
- Option A, Option B, Option C all present ✅

### 10. No biome-ignore Outside Sanctioned File
- Output: `CLEAN` ✅

## VERDICT: APPROVE
