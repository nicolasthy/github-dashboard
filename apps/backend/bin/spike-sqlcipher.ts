/**
 * T2 spike — validate `better-sqlite3-multiple-ciphers` under Bun with a raw hex key.
 *
 * Asserts the LOCKED SQLCipher open sequence:
 *   1. new Database(path)
 *   2. pragma("key = x'<64 hex chars>'")    ← raw 32-byte key, no KDF
 *   3. pragma("cipher_compatibility = 4")
 *   4. pragma("journal_mode = WAL")          ← file-backed only, AFTER key
 *   5. first SELECT 1                        ← surfaces SQLITE_NOTADB on wrong key
 *
 * On success, prints `{ v: 1 }`, `REOPEN OK`, and `WRONG KEY REJECTED` and exits 0.
 * On any failure, throws loudly — no silent fallback to plain SQLite. Bun's
 * ERR_DLOPEN_FAILED on `better_sqlite3.node` is detected and surfaced as a
 * structured BLOCKED report (see docs/encryption.md → "Runtime compatibility").
 */

import { existsSync, rmSync } from "node:fs";
import { inspect } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";

// 64 hex chars = 32 raw bytes — matches the contract the rest of the app will use.
const HEX_KEY = "00".repeat(31) + "11";
// Distinct 32-byte key used only to prove wrong-key rejection.
const WRONG_HEX_KEY = "ff".repeat(32);

type Row = { v: number };

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errorCode(err: unknown): string {
  if (err instanceof Error && "code" in err) {
    const c = (err as { code: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "(no code)";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Open an encrypted database following the canonical sequence.
 * Throws if SQLCipher rejects the key (surfaces as SQLITE_NOTADB on first SELECT).
 */
function openEncrypted(path: string, hexKey: string, withWal: boolean): Database.Database {
  const db = new Database(path);
  db.pragma(`key = x'${hexKey}'`);
  db.pragma("cipher_compatibility = 4");
  if (withWal) {
    // WAL must come AFTER the key pragma — never before.
    db.pragma("journal_mode = WAL");
  }
  // Touch the page header to confirm the key actually decrypts the DB.
  db.prepare("SELECT 1").get();
  return db;
}

function runSpike(): void {
  // ── 1. In-memory smoke ────────────────────────────────────────────────────
  out("── memory DB smoke ──");
  const mem = openEncrypted(":memory:", HEX_KEY, false);
  mem.exec("CREATE TABLE t (v INTEGER NOT NULL)");
  mem.prepare("INSERT INTO t (v) VALUES (?)").run(1);
  const memRow = mem.prepare<[], Row>("SELECT v FROM t").get();
  if (!memRow || memRow.v !== 1) {
    throw new Error(`memory DB read mismatch: ${inspect(memRow)}`);
  }
  out(inspect(memRow, { breakLength: Infinity, compact: true }));
  mem.close();

  // ── 2. File-backed persistence + reopen with same key ─────────────────────
  const tmpPath = `/tmp/spike-test-${Date.now()}.db`;
  try {
    out("── file DB persistence + reopen ──");

    const first = openEncrypted(tmpPath, HEX_KEY, true);
    first.exec("CREATE TABLE t (v INTEGER NOT NULL)");
    first.prepare("INSERT INTO t (v) VALUES (?)").run(42);
    first.close();

    const second = openEncrypted(tmpPath, HEX_KEY, true);
    const reopenedRow = second.prepare<[], Row>("SELECT v FROM t").get();
    if (!reopenedRow || reopenedRow.v !== 42) {
      throw new Error(`reopen row mismatch: ${inspect(reopenedRow)}`);
    }
    second.close();
    out("REOPEN OK");

    // ── 3. Wrong-key rejection ──────────────────────────────────────────────
    out("── wrong key rejection ──");
    let rejected = false;
    let observedCode = "(no code)";
    let observedMessage = "";
    try {
      const wrong = openEncrypted(tmpPath, WRONG_HEX_KEY, true);
      // Should never reach here — close defensively if it somehow does.
      wrong.close();
    } catch (err) {
      rejected = true;
      observedCode = errorCode(err);
      observedMessage = errorMessage(err);
      out(`  caught: code=${observedCode} message="${observedMessage}"`);
    }
    if (!rejected) {
      throw new Error("wrong key did NOT throw — SQLCipher binding is broken or missing");
    }
    out("WRONG KEY REJECTED");
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const p = `${tmpPath}${suffix}`;
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
    }
  }

  out("── all spike checks passed ──");
}

// Top-level guard — surface the well-known Bun blocker as a structured report
// before re-throwing so the process exits non-zero with the original stack intact.
try {
  runSpike();
} catch (err) {
  const code = errorCode(err);
  const message = errorMessage(err);
  const isBunDlopenBlock =
    code === "ERR_DLOPEN_FAILED" && /better-sqlite3.*not yet supported in Bun/i.test(message);

  process.stderr.write("\n── SPIKE FAILED ──\n");
  process.stderr.write(`code=${code}\n`);
  process.stderr.write(`message=${message}\n`);

  if (isBunDlopenBlock) {
    process.stderr.write(
      "\nBLOCKED: Bun cannot load the better-sqlite3 family of native bindings.\n",
    );
    process.stderr.write(
      "Root cause: better-sqlite3 (and its fork better-sqlite3-multiple-ciphers)\n",
    );
    process.stderr.write("uses V8 C++ APIs that Bun's runtime does not implement. Bun's loader\n");
    process.stderr.write("defensively blocks better_sqlite3.node to avoid a segfault.\n");
    process.stderr.write("\nUpstream tracking: https://github.com/oven-sh/bun/issues/4290\n");
    process.stderr.write("See: docs/encryption.md → 'Runtime compatibility (BLOCKER)'.\n");
  }

  // Re-throw so the process exits with a non-zero status and Bun prints the original stack.
  throw err;
}
