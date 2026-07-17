#!/usr/bin/env bash
set -euo pipefail

echo "=== CI Smoke Test ==="
echo "Bun version: $(bun --version)"
echo "Working directory: $(pwd)"

# Step 1: Install dependencies
echo ""
echo "--- Step 1: bun install ---"
bun install

# Step 2: SQLCipher/bun:sqlite binding smoke
# Note: better-sqlite3-multiple-ciphers is blocked under Bun 1.x (V8 C++ API incompatibility)
# We use bun:sqlite instead. The spike script documents this decision.
# Run the connection self-test instead:
echo ""
echo "--- Step 2: DB connector self-test ---"
PR_TRACKER_DB=/tmp/ci-smoke-test-$$.db bun -e '
import { open, close } from "./apps/backend/src/db/connection.ts";
import { unlinkSync } from "node:fs";
const db = open();
const result = db.query("SELECT 1 AS v").get();
if (!result || (result as Record<string, unknown>)["v"] !== 1) throw new Error("DB self-test failed");
close(db);
const dbPath = process.env["PR_TRACKER_DB"];
if (dbPath) unlinkSync(dbPath);
process.stdout.write("DB connector: OK\n");
'

# Step 3: Typecheck
echo ""
echo "--- Step 3: bun turbo typecheck ---"
bun turbo typecheck

# Step 4: Tests
echo ""
echo "--- Step 4: bun turbo test ---"
bun turbo test

echo ""
echo "=== CI Smoke Test PASSED ==="
