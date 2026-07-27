import { spawn } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrewConfig, ForgeProvider } from "../types.js";
import { ensureGitignored } from "../util/gitignore.js";
import { loadEnvFiles } from "../util/env.js";
import {
  AGENT_PRESETS,
  applyChoices,
  requiredEnvFor,
  type SetupChoices,
  type TrackerProvider,
} from "./choices.js";

/**
 * Ask a single-choice question, returning the chosen index. Falls back to the
 * default when stdin isn't a TTY (piped/CI runs), so setup stays scriptable.
 */
async function choose(
  rl: ReturnType<typeof createInterface>,
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  console.log(`\n${question}`);
  options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o}${i === defaultIndex ? "  (default)" : ""}`);
  });
  if (!process.stdin.isTTY) {
    console.log(`  → ${options[defaultIndex]} (non-interactive)`);
    return defaultIndex;
  }
  for (;;) {
    const answer = (await rl.question(`Choice [1-${options.length}]: `)).trim();
    if (!answer) return defaultIndex;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    console.log(`  Please enter a number between 1 and ${options.length}.`);
  }
}

/** Ask for free text, returning "" when skipped or non-interactive. */
async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  if (!process.stdin.isTTY) return "";
  return (await rl.question(question)).trim();
}

/** Interactively pick the tracker, code host, and agent CLI for this repo. */
export async function promptForChoices(): Promise<SetupChoices> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Let's pick the tools this project should use.");

    const trackers: TrackerProvider[] = ["linear", "jira"];
    const t = await choose(rl, "Which issue tracker do you use?", [
      "Linear",
      "Jira (Cloud)",
    ]);

    const forges: ForgeProvider[] = ["github", "bitbucket"];
    const f = await choose(rl, "Where do your pull requests go?", [
      "GitHub (via the gh CLI)",
      "Bitbucket Cloud (via the REST API)",
    ]);

    let bitbucketRepo: string | undefined;
    if (forges[f] === "bitbucket") {
      const answer = await ask(
        rl,
        'Bitbucket repo as "workspace/repo-slug" (blank = infer from your origin remote): ',
      );
      if (answer) bitbucketRepo = answer;
    }

    const a = await choose(
      rl,
      "Which coding-agent CLI should drive the work?",
      AGENT_PRESETS.map((p) => p.label),
    );
    const preset = AGENT_PRESETS[a];

    // "other" has no known binary — ask, rather than write an empty command.
    let agent = preset;
    if (preset.provider === "other") {
      const command = await ask(rl, "CLI binary on your PATH (e.g. my-agent): ");
      const provider = command ? basename(command) : "other";
      agent = { ...preset, provider, command };
    }

    return { tracker: trackers[t], forge: forges[f], agent, bitbucketRepo };
  } finally {
    rl.close();
  }
}

/**
 * Write the chosen providers into config.yaml. Returns false when the file is
 * missing (nothing scaffolded yet), so the caller can carry on regardless.
 */
export function writeChoices(cfg: CrewConfig, choices: SetupChoices): boolean {
  const configPath = join(cfg.configDir, "config.yaml");
  if (!existsSync(configPath)) return false;
  const before = readFileSync(configPath, "utf8");
  const after = applyChoices(before, choices);
  if (after !== before) writeFileSync(configPath, after, "utf8");
  return true;
}

/**
 * Interactive onboarding: pick the providers, then launch the configured
 * coding-agent CLI seeded with the setup prompt so an agent tailors the rest of
 * the crew config to this repo, then deterministically finalize .env and
 * .gitignore.
 */
export async function runSetup(cfg: CrewConfig): Promise<void> {
  const choices = await promptForChoices();
  writeChoices(cfg, choices);
  console.log(
    `\nRecorded: tracker=${choices.tracker}, forge=${choices.forge}, ` +
      `agent=${choices.agent.provider} in ${basename(cfg.configDir)}/config.yaml`,
  );

  // Make CLAUDE_CODE_OAUTH_TOKEN from <crewDir>/.env / ~/.crew/env available to
  // the interactive session; force subscription billing (never API credits).
  loadEnvFiles(cfg.configDir);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const promptPath = fileURLToPath(new URL("../../templates/setup-agent.md", import.meta.url));
  const prompt = readFileSync(promptPath, "utf8");

  // The onboarding agent runs on whichever CLI was just chosen. Only Claude
  // Code is known to accept a prompt as a bare argument; for anything else the
  // prompt goes in on stdin, which every CLI here supports.
  const bin = choices.agent.provider === "claude" ? "claude" : choices.agent.command?.trim();
  if (!bin) {
    console.log(
      "\nNo agent CLI configured, so skipping the tailoring step. " +
        `Edit ${basename(cfg.configDir)}/config.yaml and constitution.md by hand.`,
    );
  } else {
    const viaStdin = choices.agent.provider !== "claude";
    const args = choices.agent.provider === "claude" ? [prompt] : (choices.agent.args ?? []);
    console.log(
      `\nLaunching ${bin} to tailor ${basename(cfg.configDir)}/ to this repo…\n`,
    );
    await new Promise<void>((resolve) => {
      const child = spawn(bin, args, {
        cwd: cfg.repo.path,
        // Hand the interactive session to the user's terminal, except for the
        // stdin pipe we need to feed the prompt through.
        stdio: viaStdin ? ["pipe", "inherit", "inherit"] : "inherit",
        env,
      });
      child.on("error", (e) => {
        console.error(`Could not launch ${bin}: ${(e as Error).message}`);
        resolve();
      });
      child.on("close", () => resolve());
      if (viaStdin) {
        child.stdin?.end(prompt);
      }
    });
  }

  console.log("\nFinalizing secrets + gitignore…");
  finalizeEnvAndGitignore(cfg, choices);
}

/** Create <crewDir>/.env from the example if missing, and gitignore it. */
export function finalizeEnvAndGitignore(
  cfg: CrewConfig,
  choices?: SetupChoices,
): void {
  const envFile = join(cfg.configDir, ".env");
  const example = join(cfg.configDir, ".env.example");
  if (!existsSync(envFile) && existsSync(example)) {
    copyFileSync(example, envFile);
    // Name the variables the chosen providers actually need, rather than
    // assuming Linear + Claude as this used to.
    const needed = choices ? requiredEnvFor(choices).join(", ") : "your provider credentials";
    console.log(`  created ${envFile} — fill in ${needed}`);
  }
  const pattern = `${basename(cfg.configDir)}/.env`;
  const g = ensureGitignored(cfg.repo.path, pattern);
  console.log(
    g === "added" ? `  added \`${pattern}\` to .gitignore` : `  \`${pattern}\` already gitignored`,
  );
}
