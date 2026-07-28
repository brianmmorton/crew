import { spawn } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrewConfig, ForgeProvider } from "../types.js";
import { ensureGitignored } from "../util/gitignore.js";
import { inspectRepo, trackedFileCount, type RepoFacts } from "../git/discover.js";
import { loadEnvFiles } from "../util/env.js";
import {
  AGENT_PRESETS,
  applyChoices,
  requiredEnvFor,
  type SetupChoices,
  type TrackerProvider,
} from "./choices.js";

/**
 * Tracked-file count above which worktree reuse is worth offering.
 *
 * Deliberately high. Below this a cold checkout is seconds, so reuse trades
 * away cold-tree verification for no real gain — and a question implies the
 * trade is worth weighing. Most repos never see this prompt.
 */
const LARGE_REPO_FILES = 25_000;

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

/**
 * Interactively pick the tracker, code host, and agent CLI for this repo.
 *
 * `facts` are whatever git already told us about the checkout. Anything in
 * there is presented as a detected default rather than asked from scratch —
 * the origin remote knows the code host better than the person typing.
 */
export async function promptForChoices(facts: RepoFacts = {}): Promise<SetupChoices> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Let's pick the tools this project should use.");
    if (facts.root) {
      console.log(`\nDetected repo:   ${facts.root}`);
      if (facts.baseBranch) console.log(`Detected base:   ${facts.baseBranch}`);
      if (facts.originUrl) console.log(`Detected origin: ${facts.originUrl}`);
    }

    const trackers: TrackerProvider[] = ["linear", "jira"];
    const t = await choose(rl, "Which issue tracker do you use?", [
      "Linear",
      "Jira (Cloud)",
    ]);

    const forges: ForgeProvider[] = ["github", "bitbucket"];
    // Preselect what the remote says; the question stays so a repo whose PRs
    // live somewhere other than its origin can still be corrected.
    const detectedForge = facts.forge ? forges.indexOf(facts.forge) : 0;
    const f = await choose(
      rl,
      facts.forge
        ? `Where do your pull requests go? (detected ${facts.forge} from your origin remote)`
        : "Where do your pull requests go?",
      ["GitHub (via the gh CLI)", "Bitbucket Cloud (via the REST API)"],
      detectedForge,
    );

    let bitbucketRepo: string | undefined;
    if (forges[f] === "bitbucket") {
      // Only worth asking when the remote didn't already yield the slug.
      if (facts.bitbucketRepo && forges[f] === facts.forge) {
        console.log(`  → using ${facts.bitbucketRepo} (from your origin remote)`);
      } else {
        const answer = await ask(
          rl,
          'Bitbucket repo as "workspace/repo-slug" (blank = infer from your origin remote): ',
        );
        if (answer) bitbucketRepo = answer;
      }
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

    // Worktree reuse is only offered on repos big enough for it to pay for
    // itself. On a small checkout the honest answer is "no" — asking anyway
    // would imply the trade is worth considering when it isn't.
    let worktreeReuse: boolean | undefined;
    let worktreeMax: number | undefined;
    const files = facts.root ? trackedFileCount(facts.root) : null;
    if (files !== null && files >= LARGE_REPO_FILES) {
      console.log(
        `\nThis repo tracks ${files.toLocaleString()} files. Each agent normally gets a\n` +
          `fresh worktree, which on a repo this size means a full checkout plus a\n` +
          `dependency install every cycle. crew can instead keep a pool of worktrees\n` +
          `and reset them between cycles, preserving node_modules and build caches.\n` +
          `\n` +
          `The trade: a reused worktree carries residue from the previous cycle, so\n` +
          `a verify pass means "passes given what the last agent left behind" rather\n` +
          `than "passes cold" — cold-tree breakage surfaces in CI instead of here.`,
      );
      const reuse = await choose(
        rl,
        "Reuse a pool of worktrees?",
        [
          "No — a fresh worktree per cycle (always verifies cold)",
          "Yes — reuse a pool (faster cycles, carries residue)",
        ],
        0,
      );
      worktreeReuse = reuse === 1;

      if (worktreeReuse) {
        // Each slot is a full checkout of a repo we just established is large,
        // so this number is a disk budget as much as a concurrency setting.
        const answer = await ask(
          rl,
          "How many worktrees may run at once? Each is a full checkout [2]: ",
        );
        const n = Number(answer);
        worktreeMax = Number.isInteger(n) && n >= 1 && n <= 32 ? n : 2;
        console.log(`  → ${worktreeMax} worktree(s). Run \`crew worktrees warm\` to create them up front.`);
      }
    }

    return {
      tracker: trackers[t],
      forge: forges[f],
      agent,
      bitbucketRepo,
      baseBranch: facts.baseBranch,
      worktreeReuse,
      worktreeMax,
    };
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
 * Launch a coding-agent CLI as a live interactive session seeded with a
 * starting prompt, and wait for it to exit. Used for onboarding steps that
 * need a real back-and-forth with the user rather than a headless run.
 *
 * Only Claude Code is known to accept a prompt as a bare argument; for
 * anything else the prompt goes in on stdin, which every CLI here supports.
 */
export async function launchInteractiveAgent(
  cfg: CrewConfig,
  agent: { provider: string; command?: string; args?: string[] },
  prompt: string,
): Promise<void> {
  // Make CLAUDE_CODE_OAUTH_TOKEN from <crewDir>/.env / ~/.crew/env available to
  // the interactive session; force subscription billing (never API credits).
  loadEnvFiles(cfg.configDir);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const bin = agent.provider === "claude" ? "claude" : agent.command?.trim();
  if (!bin) {
    console.log(
      "\nNo agent CLI configured — set one up with `crew setup`, or run `claude` yourself.",
    );
    return;
  }

  const viaStdin = agent.provider !== "claude";
  const args = agent.provider === "claude" ? [prompt] : (agent.args ?? []);
  console.log(`\nLaunching ${bin}…\n`);
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

/**
 * Interactive onboarding: pick the providers, then launch the configured
 * coding-agent CLI seeded with the setup prompt so an agent tailors the rest of
 * the crew config to this repo, then deterministically finalize .env and
 * .gitignore.
 */
export async function runSetup(cfg: CrewConfig): Promise<void> {
  const choices = await promptForChoices(inspectRepo(cfg.repo.path));
  writeChoices(cfg, choices);
  console.log(
    `\nRecorded: tracker=${choices.tracker}, forge=${choices.forge}, ` +
      `agent=${choices.agent.provider} in ${basename(cfg.configDir)}/config.yaml`,
  );

  const promptPath = fileURLToPath(new URL("../../templates/setup-agent.md", import.meta.url));
  const prompt = readFileSync(promptPath, "utf8");
  console.log(`Tailoring ${basename(cfg.configDir)}/ to this repo…`);
  await launchInteractiveAgent(cfg, choices.agent, prompt);

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
