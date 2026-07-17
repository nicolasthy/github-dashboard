import { issueToken, listTokens, revokeToken } from "../src/auth/token-store";
import { open } from "../src/db/connection";

const [, , subcommand, ...args] = process.argv;

async function main(): Promise<void> {
  const db = open();

  try {
    if (subcommand === "issue") {
      const labelFlag = args.indexOf("--label");
      const label = labelFlag >= 0 ? args[labelFlag + 1] : "default";
      if (!label) {
        process.stderr.write("Usage: bun run token issue --label <name>\n");
        process.exit(1);
      }
      const { token_id, token_plaintext } = await issueToken(db, label);
      process.stdout.write(`Token: ${token_plaintext}\nID: ${token_id}\nLabel: ${label}\n`);
    } else if (subcommand === "list") {
      const tokens = listTokens(db);
      if (tokens.length === 0) {
        process.stdout.write("No tokens issued.\n");
      } else {
        for (const t of tokens) {
          process.stdout.write(
            `${t.token_id}\t${t.label}\t${t.created_at}\t${t.last_used_at ?? "never"}\n`,
          );
        }
      }
    } else if (subcommand === "revoke") {
      const token_id = args[0];
      if (!token_id) {
        process.stderr.write("Usage: bun run token revoke <token_id>\n");
        process.exit(1);
      }
      revokeToken(db, token_id);
      process.stdout.write(`Revoked: ${token_id}\n`);
    } else {
      process.stderr.write("Usage: bun run token <issue|list|revoke> [args]\n");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

await main();
