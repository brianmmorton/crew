#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, crewDirName } from "../config/load.js";
import { buildPorts } from "../engine/ports.js";
import { implementerCycle, proposerCycle } from "../engine/cycles.js";
import { runSupervised } from "../engine/supervisor.js";
import { runSetup } from "../setup/onboard.js";
import { ensureGitignored } from "../util/gitignore.js";
import { runDoctor } from "../util/doctor.js";
import { logger, logToFile, logFilePath } from "../util/logger.js";
import { Cron } from "croner";
import type { CrewConfig, PersonaName } from "../types.js";

/** Compute the next fire time for a cron cadence, or null if it never/invalid. */
function nextRunFor(cadence: string): Date | null {
  try {
    const c = new Cron(cadence, { paused: true });
    const n = c.nextRun();
    c.stop();
    return n;
  } catch {
    return null;
  }
}

const SCHEDULED: PersonaName[] = ["qa", "design", "architect"];

function printSchedule(cfg: CrewConfig, enabled: PersonaName[]): void {
  console.log("schedule (proposers):");
  let any = false;
  for (const name of SCHEDULED) {
    const p = cfg.personas[name];
    if (!p || !enabled.includes(name) || !p.cadence || p.cadence === "continuous") continue;
    any = true;
    const next = nextRunFor(p.cadence);
    console.log(
      `  ${name.padEnd(10)} ${p.cadence.padEnd(14)} next: ${next ? next.toLocaleString() : "—"}`,
    );
  }
  if (!any) console.log("  (none enabled)");
  console.log(`  implementer  continuous    (runs whenever there is Todo work)`);
}

const program = new Command();
program
  .name("crew")
  .description("Autonomous agent team: propose typed work into Linear, gate material changes behind human-approved PRDs, drain approved work into PRs.")
  .version("0.1.0");

/** Recursively copy template tree into dest, never overwriting existing files. */
function copyNoOverwrite(src: string, dest: string): string[] {
  const written: string[] = [];
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) {
      written.push(...copyNoOverwrite(s, d));
    } else if (!existsSync(d)) {
      cpSync(s, d);
      written.push(d);
    }
  }
  return written;
}

const TEMPLATES = () => fileURLToPath(new URL("../../templates/agents", import.meta.url));

program
  .command("init")
  .description("Scaffold generic crew config (default .crew/) into the current repo")
  .action(() => {
    const dir = crewDirName();
    const dest = join(process.cwd(), dir);
    const written = copyNoOverwrite(TEMPLATES(), dest);
    if (written.length === 0) {
      console.log(`${dir}/ already present — nothing overwritten.`);
    } else {
      console.log(`Scaffolded generic ${dir}/ templates:`);
      for (const w of written) console.log("  " + w);
    }
    ensureGitignored(process.cwd(), `${dir}/.env`);
    console.log(
      "\nThe templates are generic. Recommended next step:\n" +
        "  crew setup        # an agent tailors the personas/constitution/config to THIS repo,\n" +
        "                    # then sets up .env and .gitignore for you\n" +
        `\nOr configure by hand: edit ${dir}/config.yaml + constitution.md, then\n` +
        `cp ${dir}/.env.example ${dir}/.env and fill in your secrets.`,
    );
  });

program
  .command("setup")
  .description("Onboard this repo: an agent tailors the crew config to your project, then sets up .env + .gitignore")
  .action(async () => {
    const dir = crewDirName();
    const dest = join(process.cwd(), dir);
    if (!existsSync(join(dest, "config.yaml"))) {
      copyNoOverwrite(TEMPLATES(), dest);
      console.log(`Scaffolded generic ${dir}/ templates first.\n`);
    }
    const cfg = loadConfig();
    await runSetup(cfg);
    console.log("\nChecking prerequisites:");
    await runDoctor(cfg, logger);
  });

program
  .command("doctor")
  .description("Check that required tools (git, gh, claude) and secrets are present")
  .action(async () => {
    const cfg = loadConfig();
    console.log("Prerequisites:");
    const ok = await runDoctor(cfg, logger);
    process.exit(ok ? 0 : 1);
  });

program
  .command("status")
  .description("Print backlog / WIP counts and a config summary")
  .action(async () => {
    const cfg = loadConfig();
    const ports = await buildPorts(cfg);
    const [backlog, inProgress] = await Promise.all([
      ports.linear.countBacklog(),
      ports.linear.countInProgress(),
    ]);
    const enabled = Object.keys(ports.prompts) as PersonaName[];
    console.log(`project:      ${cfg.project}`);
    console.log(`repo:         ${cfg.repo.path} (base ${cfg.repo.baseBranch})`);
    console.log(`linear team:  ${cfg.linear.team}${cfg.linear.project ? ` / project: ${cfg.linear.project}` : ""}`);
    console.log(`backlog:      ${backlog}   (cap ${cfg.triager.backlogCap})`);
    console.log(`in progress:  ${inProgress} (WIP cap ${cfg.gates.wipCap})`);
    console.log(`personas:     ${enabled.join(", ") || "(none found)"}`);
    console.log("");
    printSchedule(cfg, enabled);
    console.log("");
    console.log(`log file:     ${logFilePath(cfg.configDir)}`);
    console.log(`run sooner:   crew once <qa|design|architect|implementer>`);
  });

program
  .command("once")
  .argument("<persona>", "implementer | qa | design | architect")
  .description("Run a single cycle of one persona (what launchd/cron fires on cadence)")
  .action(async (persona: string) => {
    const cfg = loadConfig();
    logToFile(logFilePath(cfg.configDir));
    const ports = await buildPorts(cfg);
    const name = persona as PersonaName;
    const outcome =
      name === "implementer"
        ? await implementerCycle(cfg, ports, logger)
        : await proposerCycle(cfg, ports, name, logger);
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("run")
  .description("Run the whole team in one process: executor loop + proposers on their cadence")
  .option("--no-proposers", "run only the executor loop (no scheduled proposers)")
  .option("--kickoff", "also run each proposer once immediately at startup")
  .action(async (opts: { proposers: boolean; kickoff?: boolean }) => {
    const cfg = loadConfig();
    const logPath = logFilePath(cfg.configDir);
    logToFile(logPath);
    console.error(`crew: logging to ${logPath}  (tail -f to follow)`);
    await runDoctor(cfg, logger, true); // quiet: warn on missing prereqs, continue
    const ports = await buildPorts(cfg);
    await runSupervised(cfg, ports, logger, {
      proposers: opts.proposers,
      kickoff: !!opts.kickoff,
    });
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});

// silence unused import in some tsc configs
void dirname;
