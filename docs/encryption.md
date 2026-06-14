# SQLCipher / Encryption at Rest

## v1 Decision: bun:sqlite (SQLCipher deferred)

**Status**: SQLCipher encryption deferred to v2.

**Reason**: `better-sqlite3-multiple-ciphers@12.10.0` uses V8 C++ APIs (`NODE_MODULE_INIT`, `node.h`) that Bun's JavaScriptCore runtime does not implement. Bun's loader blocks the `.node` binding with `ERR_DLOPEN_FAILED`. This affects all Bun 1.x versions on all platforms.

**v1 approach**: Use `bun:sqlite` (Bun's native SQLite). The DB file is protected by OS-level disk encryption (macOS FileVault / Linux LUKS). No application-level encryption in v1.

**v2 path**: When Bun adds native addon support (tracked in oven-sh/bun#4290) or when `bun:sqlite` gains SQLCipher support (oven-sh/bun#11397), upgrade `connection.ts` to add the PRAGMA key sequence. The interface contract (`open()`, `close()`, `selfTest()`) is preserved — only the internals change.

**Evidence**: `.omo/evidence/task-2-sqlcipher-spike.txt`

---

# Encryption

> Canonical reference for the SQLCipher binding used by `@repo/backend`. Owner: backend.
> Locked by T2 spike (`apps/backend/bin/spike-sqlcipher.ts`).

## Runtime compatibility (BLOCKER — surfaced by T2 spike)

> ⛔ **The plan's chosen runtime + library combination does not work today.**
> Resolved by T2 running the spike and capturing the failure mode below.
> See evidence: `.omo/evidence/task-2-sqlcipher-spike.txt`.

`better-sqlite3-multiple-ciphers@12.10.0` is a fork of `better-sqlite3` and shares its native binding (`build/Release/better_sqlite3.node`). That binding is written against V8 C++ APIs (`#include <node.h>`, `node_object_wrap.h`, `NODE_MODULE_INIT`) rather than pure N-API. **Bun 1.3.11 (and every earlier 1.x) refuses to load it.** The Bun runtime defensively short-circuits the `dlopen` of any file matching `better_sqlite3.node` and throws:

```
error: 'better-sqlite3' is not yet supported in Bun.
Track the status in https://github.com/oven-sh/bun/issues/4290
In the meantime, you could try bun:sqlite which has a similar API.
 code: "ERR_DLOPEN_FAILED"
```

Bypassing the loader check (renaming the `.node` file) makes Bun **segfault** inside the binding's first `v8::Isolate::Isolate` call — confirmed locally on this branch. This is not a build, install, or version issue: it is a fundamental compatibility gap between Bun's JavaScriptCore-based runtime and the V8 C++ ABI the binding expects.

### Concrete consequences

- `bun --filter @repo/backend run spike:sqlcipher` **cannot** succeed under any current Bun version. The spike correctly throws `ERR_DLOPEN_FAILED` from inside `new Database(":memory:")` and exits non-zero.
- The `bun rebuild better-sqlite3-multiple-ciphers` postinstall in `apps/backend/package.json` is a no-op: `bun rebuild` is not a real Bun subcommand (it errors with `Script not found "rebuild"`). The native binding had to be compiled manually with `bunx --bun node-gyp rebuild --release` during T2 just to reach the `dlopen` block.

### Recovery paths (decide in re-plan, do not pick silently)

1. **Swap binding → `bun:sqlite` + a SQLCipher build of SQLite.** `bun:sqlite` works on Bun but does not yet expose SQLCipher hooks ([oven-sh/bun#11397](https://github.com/oven-sh/bun/issues/11397)). Requires either waiting for that landing or shipping a custom Bun built against `sqlite3mc`.
2. **Swap runtime → run the DB-touching paths under Node.** Either move `@repo/backend` to Node entirely, or split out a `db` subprocess on Node while the rest of the app stays on Bun.
3. **Fork the binding for Bun.** A working patch already exists in `rocicorp/zero-sqlite3#13`. Porting those changes to `better-sqlite3-multiple-ciphers` is non-trivial but tractable.
4. **Defer encryption-at-rest.** Ship with plain `bun:sqlite` and OS-level disk encryption only; revisit once #11397 lands.

### Canonical open sequence still applies

Everything below (open order, raw hex key, WAL placement, wrong-key behaviour) is the contract we will honour **once one of the recovery paths above is chosen**. The spike implements this sequence verbatim, so as soon as the runtime gap is closed the spike will start passing without code changes.

## Stack

| Layer | Choice | Pinned at |
|------|--------|-----------|
| Binding | `better-sqlite3-multiple-ciphers` | `12.10.0` (exact, no caret) |
| Runtime | Bun on darwin-arm64 | `bun rebuild better-sqlite3-multiple-ciphers` in `apps/backend` postinstall |
| Cipher  | SQLCipher 4 (`cipher_compatibility = 4`) | default page size, default HMAC |
| Key     | Raw 32-byte hex blob via `PRAGMA key = x'…'` | **no KDF, no passphrase** |

## Canonical open sequence (LOCKED)

Every code path that opens an encrypted database **must** run these calls in this exact order:

```ts
const db = new Database(path);                  // 1. open handle
db.pragma(`key = x'${hexKey}'`);                // 2. install raw 32-byte key (no KDF)
db.pragma("cipher_compatibility = 4");          // 3. pin SQLCipher 4 page format
if (filePath) db.pragma("journal_mode = WAL");  // 4. WAL only after key, file-backed only
db.prepare("SELECT 1").get();                   // 5. force header decrypt → throws on wrong key
```

Rules:

1. **`new Database(path)` first.** Do not pass key options in the constructor — the binding accepts a `key` option but it routes through the KDF path, which is exactly what we are avoiding.
2. **Key pragma second, before *any* other pragma or query.** SQLCipher will not retroactively decrypt pages that were touched before the key was installed.
3. **`cipher_compatibility = 4` third.** This pins SQLCipher 4 defaults (page size 4096, HMAC SHA-512, 256000 iterations — ignored when using a raw key but still required to lock the page format).
4. **`journal_mode = WAL` fourth, file-backed only.** WAL is illegal on `:memory:` databases (the spike asserts this by skipping it for the in-memory smoke). WAL must be enabled **after** the key pragma; enabling it first writes an unencrypted WAL header.
5. **First `SELECT 1` fifth.** This is the smoke check: it forces the binding to decrypt page 1. If the key is wrong, this is where `SQLITE_NOTADB` ("file is not a database") surfaces. **Without this probe, a wrong key silently looks healthy until the first real query.**

## Raw hex key contract

- Keys are **32 raw bytes**, encoded as **64 lowercase hex characters**.
- Wire format inside the pragma is the SQLite blob literal: `x'<64 hex chars>'` (single quotes, lowercase `x`).
- **Never pass a passphrase string.** `PRAGMA key = 'something'` would silently run PBKDF2 over `something`, which is not the contract this app commits to.
- The spike uses `"00".repeat(31) + "11"` purely as a deterministic test fixture. The real key in production comes from `PR_TRACKER_KEY` (see future task T-keying).

## Wrong-key behaviour

Opening a SQLCipher database with the wrong key does **not** throw at `pragma("key = …")`. The key pragma only stores bytes. The error surfaces on the **first page-touching operation**, which is why step 5 in the sequence above is mandatory:

- The binding raises an `Error` whose `code` is `"SQLITE_NOTADB"`.
- The message is the unhelpful `"file is not a database"` — see the [issues notepad](../.omo/notepads/github-pr-tracker/issues.md) for the gotcha.
- The DB module is expected to wrap this case in a domain-specific `WrongKeyError` so callers do not have to string-match on SQLite codes (deferred to T-db-wrapper).

## What the T2 spike proves

`apps/backend/bin/spike-sqlcipher.ts` is the executable contract for everything above. Run with:

```bash
bun --filter @repo/backend run spike:sqlcipher
```

Expected output (exit 0):

```
── memory DB smoke ──
{ v: 1 }
── file DB persistence + reopen ──
REOPEN OK
── wrong key rejection ──
  caught: code=SQLITE_NOTADB message="…"
WRONG KEY REJECTED
── all spike checks passed ──
```

The spike covers:

- `:memory:` open + key + `cipher_compatibility=4` + `SELECT 1` + round-trip insert/select.
- File-backed open with WAL, insert, close, **reopen with same key**, read row back (proves on-disk persistence with encryption).
- File-backed open with a **different** key — confirms the binding throws and surfaces `SQLITE_NOTADB`.

## Things deferred (do not add to the spike)

- WAL/checkpoint tuning, `synchronous=NORMAL`, `temp_store=MEMORY` → owned by T7 (DB module hardening).
- `PRAGMA foreign_keys = ON` → owned by the schema/migrations task.
- Key rotation (`rekey`) → must switch to `journal_mode = DELETE` before rekey; out of scope until rotation is needed.
- KMS / OS keychain integration for `PR_TRACKER_KEY` → out of scope; key sourcing lives in the config layer.
