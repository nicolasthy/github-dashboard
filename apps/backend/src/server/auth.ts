import type { Database } from "bun:sqlite";
import type { ApiToken } from "@repo/types";
import { verifyToken } from "../auth/token-store.ts";

const UNAUTHORIZED = new Response(JSON.stringify({ error: "unauthorized" }), {
  status: 401,
  headers: { "Content-Type": "application/json" },
});

/**
 * Returns a middleware function that extracts and verifies the Bearer token.
 * On success: returns the ApiToken row.
 * On failure: returns a 401 Response (no detail to prevent timing/error parity).
 */
export function requireBearer(db: Database): (req: Request) => Promise<ApiToken | Response> {
  return async (req: Request): Promise<ApiToken | Response> => {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return UNAUTHORIZED;
    }

    const plaintext = authHeader.slice("Bearer ".length);
    const token = await verifyToken(db, plaintext);
    if (!token) {
      return UNAUTHORIZED;
    }

    return token;
  };
}
