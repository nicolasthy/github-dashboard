# Issues — github-pr-tracker

## [2026-06-14] Known Gotchas (from plan)
- exactOptionalPropertyTypes:true may surface friction with Zod v3 inferred types — fix the type, don't disable
- noUndeclaredEnvVars (Biome nursery) requires env vars in turbo.json globalEnv array
- "extends": "//" Biome microsyntax has resolution bugs from subfolders — ALWAYS run bun turbo check from monorepo root
- better-sqlite3-multiple-ciphers@12.10.0 is the ONLY version with reliable Bun N-API loading on darwin-arm64
- PRAGMA key error masquerades as "not a database" — expose custom WrongKeyError
- WAL must be enabled AFTER key pragma, NOT before
- Do NOT rekey under WAL (must switch to DELETE journal mode first)
- postinstall: "bun rebuild better-sqlite3-multiple-ciphers" at workspace level (apps/backend), NOT root
