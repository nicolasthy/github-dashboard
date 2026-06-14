import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import type { Database } from "bun:sqlite";
import type { ApiToken } from "@repo/types";

// OWASP-recommended argon2id params
const ARGON2_OPTIONS = {
	type: argon2.argon2id,
	memoryCost: 19456, // 19 MiB
	timeCost: 2,
	parallelism: 1,
} as const;

const TOKEN_PREFIX = "gpt_";

function generatePlaintext(): string {
	return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export async function issueToken(
	db: Database,
	label: string,
): Promise<{ token_id: string; token_plaintext: string }> {
	const plaintext = generatePlaintext();
	const hash = await argon2.hash(plaintext, ARGON2_OPTIONS);
	const token_id = "tok_" + randomBytes(8).toString("hex");
	const now = new Date().toISOString();

	db.prepare(
		"INSERT INTO api_token (token_id, hash, label, created_at) VALUES (?, ?, ?, ?)",
	).run(token_id, hash, label, now);

	return { token_id, token_plaintext: plaintext };
}

export async function verifyToken(
	db: Database,
	plaintext: string,
): Promise<ApiToken | null> {
	const rows = db.query("SELECT * FROM api_token").all() as ApiToken[];

	for (const row of rows) {
		const matches = await argon2.verify(row.hash, plaintext);
		if (matches) {
			// Update last_used_at
			db.prepare(
				"UPDATE api_token SET last_used_at = ? WHERE token_id = ?",
			).run(new Date().toISOString(), row.token_id);
			return row;
		}
	}
	return null;
}

export function revokeToken(db: Database, token_id: string): void {
	db.prepare("DELETE FROM api_token WHERE token_id = ?").run(token_id);
}

export function listTokens(db: Database): Omit<ApiToken, "hash">[] {
	return db
		.query(
			"SELECT token_id, label, created_at, last_used_at FROM api_token ORDER BY created_at DESC",
		)
		.all() as Omit<ApiToken, "hash">[];
}
