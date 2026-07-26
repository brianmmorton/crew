import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Apply KEY=VALUE lines from a dotenv-style file into process.env, but only for
 * keys not already set — so a real shell export always wins over a file.
 * Supports `export KEY=val`, `#` comments, blank lines, and quoted values.
 */
function applyEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/**
 * Load secrets from, in order of precedence (highest first):
 *   1. the real shell environment (already in process.env),
 *   2. <repo>/.agents/.env         (per-project),
 *   3. ~/.crew/env                 (global, e.g. for launchd).
 */
export function loadEnvFiles(agentsDir: string): void {
  applyEnvFile(join(agentsDir, ".env"));
  applyEnvFile(join(homedir(), ".crew", "env"));
}
