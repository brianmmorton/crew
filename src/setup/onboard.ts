import { spawn } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrewConfig } from "../types.js";
import { ensureGitignored } from "../util/gitignore.js";
import { loadEnvFiles } from "../util/env.js";

/**
 * Interactive onboarding: launch a Claude Code session seeded with the setup
 * prompt so an agent tailors the crew config to this repo, then deterministically
 * finalize .env and .gitignore.
 */
export async function runSetup(cfg: CrewConfig): Promise<void> {
  // Make CLAUDE_CODE_OAUTH_TOKEN from <crewDir>/.env / ~/.crew/env available to
  // the interactive session; force subscription billing (never API credits).
  loadEnvFiles(cfg.configDir);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const promptPath = fileURLToPath(new URL("../../templates/setup-agent.md", import.meta.url));
  const prompt = readFileSync(promptPath, "utf8");

  console.log(`Launching an onboarding agent to tailor ${basename(cfg.configDir)}/ to this repo…\n`);
  await new Promise<void>((resolve) => {
    const child = spawn("claude", [prompt], {
      cwd: cfg.repo.path,
      stdio: "inherit", // hand the interactive session to the user's terminal
      env,
    });
    child.on("error", (e) => {
      console.error(`Could not launch claude: ${(e as Error).message}`);
      resolve();
    });
    child.on("close", () => resolve());
  });

  console.log("\nFinalizing secrets + gitignore…");
  finalizeEnvAndGitignore(cfg);
}

/** Create <crewDir>/.env from the example if missing, and gitignore it. */
export function finalizeEnvAndGitignore(cfg: CrewConfig): void {
  const envFile = join(cfg.configDir, ".env");
  const example = join(cfg.configDir, ".env.example");
  if (!existsSync(envFile) && existsSync(example)) {
    copyFileSync(example, envFile);
    console.log(`  created ${envFile} — fill in LINEAR_API_KEY and CLAUDE_CODE_OAUTH_TOKEN`);
  }
  const pattern = `${basename(cfg.configDir)}/.env`;
  const g = ensureGitignored(cfg.repo.path, pattern);
  console.log(
    g === "added" ? `  added \`${pattern}\` to .gitignore` : `  \`${pattern}\` already gitignored`,
  );
}
