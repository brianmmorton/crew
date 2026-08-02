#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig, crewDirName, crewRepoOverride } from "../config/load.js";
import { inspectRepo } from "../git/discover.js";
import { buildPorts } from "../engine/ports.js";
import { implementerCycle, proposerCycle } from "../engine/cycles.js";
import { runDrainSession } from "../engine/drain.js";
import { runSetup, launchInteractiveAgent } from "../setup/onboard.js";
import { ensureGitignored } from "../util/gitignore.js";
import { checkLabelGate, runDoctor } from "../util/doctor.js";
import { probeDecision, probeVerify } from "../gates/probe.js";
import { logger, logToFile, logFilePath } from "../util/logger.js";
import { setColorEnabled } from "../util/color.js";
import { Cron } from "croner";
import { writeFileSync } from "node:fs";
import {
  agentsOfKind,
  discoverPersonaFiles,
  drainAgents,
  isValidAgentName,
  loadAgents,
  orphanedConfigEntries,
  personasDir,
  scheduledAgents,
} from "../agent/agents.js";
import type { AgentDef, AgentKind, CrewConfig, PersonaName } from "../types.js";
import { GitAdapter } from "../git/git.js";
import { destroySlot, poolStatus, releaseSlot, worktreeRootFor } from "../git/pool.js";
import { formatStuck, stuckItems } from "../engine/stuck.js";
import { listClaims, releaseClaim } from "../engine/claim.js";
import { clearVerifyFailure } from "../util/verifyfail.js";
import { setResumeAttempts, setVerifyAttempts } from "../util/state.js";
import { forgetToken, hasStoredToken } from "../config/oauth.js";
import { refreshAgentsDoc } from "../setup/agentsDoc.js";

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

function printSchedule(agents: AgentDef[]): void {
  console.log("schedule:");
  const sched = scheduledAgents(agents).sort((a, b) => a.name.localeCompare(b.name));
  for (const a of sched) {
    const next = nextRunFor(a.cadence);
    console.log(
      `  ${a.name.padEnd(14)} ${a.cadence.padEnd(14)} next: ${next ? next.toLocaleString() : "—"}`,
    );
  }
  if (!sched.length) console.log("  (no scheduled agents)");
  for (const a of drainAgents(agents)) {
    console.log(`  ${a.name.padEnd(14)} drain          (manual: crew drain ${a.name})`);
  }
  for (const a of agentsOfKind(agents, "executor")) {
    console.log(`  ${a.name.padEnd(14)} continuous     (runs whenever there is ready work)`);
  }
  for (const a of agentsOfKind(agents, "reviewer")) {
    console.log(`  ${a.name.padEnd(14)} on-pr          (runs after a PR is opened)`);
  }
}

/**
 * crew's own version, read from the installed package.json rather than
 * hardcoded — the literal that used to live here had already drifted behind a
 * version bump, which is exactly what `crew --version` must not do.
 */
function packageVersion(): string {
  try {
    const pkg = fileURLToPath(new URL("../../package.json", import.meta.url));
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** One-line description of the code host, including how it authenticates. */
function forgeSummary(cfg: CrewConfig): string {
  if (cfg.repo.forge === "bitbucket") {
    const where = cfg.repo.bitbucketRepo ?? "(inferred from the origin remote)";
    return `bitbucket — ${where}`;
  }
  return "github — via the gh CLI";
}

/** One-line description of which coding-agent CLI drives the work. */
function agentSummary(cfg: CrewConfig): string {
  if (cfg.agent.provider === "claude") return "claude (built-in adapter)";
  const bin = cfg.agent.command?.trim();
  const args = cfg.agent.args.length ? ` ${cfg.agent.args.join(" ")}` : "";
  return bin
    ? `${cfg.agent.provider} — ${bin}${args} (prompt via ${cfg.agent.promptVia})`
    : `${cfg.agent.provider} — no agent.command set`;
}

const program = new Command();
program
  .name("crew")
  .description("Autonomous agent team: propose typed work into Linear or Jira, gate material changes behind human-approved PRDs, drain approved work into PRs.")
  .version(packageVersion())
  .option(
    "-C, --repo <path>",
    "run against the repo at <path> instead of the current directory (also: CREW_REPO)",
  )
  .option("--no-color", "disable colored log output (also: NO_COLOR)")
  .hook("preAction", (thisCommand) => {
    // Commander parses global options into the root command, so translating the
    // flag into CREW_REPO here means every subcommand's bare `loadConfig()`
    // picks it up without threading an argument through each action.
    const opts = thisCommand.opts();
    const repo = opts.repo as string | undefined;
    if (repo) process.env.CREW_REPO = repo;
    // `--no-color` gives commander `color: false`; only ever force colors OFF
    // here, so the auto-detected default (TTY, NO_COLOR, FORCE_COLOR) still
    // decides when the flag is absent.
    if (opts.color === false) setColorEnabled(false);
  });

/**
 * Recursively copy template tree into dest, never overwriting existing files.
 *
 * Skips AGENTS.md: unlike every other template here it's crew-owned rather
 * than user-owned, needs its version placeholder substituted, and is meant to
 * be refreshed on upgrade rather than left alone forever — see
 * `refreshAgentsDoc`, which every caller of this function also calls.
 */
function copyNoOverwrite(src: string, dest: string): string[] {
  const written: string[] = [];
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (src === TEMPLATES() && entry === "AGENTS.md") continue;
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

/**
 * Where `init`/`setup` should scaffold the crew dir. Unlike every other
 * command these run before a config exists, so they can't use loadConfig's
 * upward search — they anchor on the git root instead, which keeps
 * `crew init` from writing a stray .crew/ into a subdirectory.
 */
function scaffoldTarget(): string {
  const explicit = crewRepoOverride();
  const start = explicit ?? process.cwd();
  const facts = inspectRepo(start);
  if (!facts.root) {
    console.error(
      `${start} is not a git repository. crew needs one to create worktrees ` +
        `and open pull requests — run \`git init\` (or cd into your repo) first.`,
    );
    process.exit(1);
  }
  return facts.root;
}

program
  .command("init")
  .description("Scaffold generic crew config (default .crew/) into the current repo")
  .action(() => {
    const dir = crewDirName();
    const target = scaffoldTarget();
    const dest = join(target, dir);
    const written = copyNoOverwrite(TEMPLATES(), dest);
    if (written.length === 0) {
      console.log(`${dir}/ already present — nothing overwritten.`);
    } else {
      console.log(`Scaffolded generic ${dir}/ templates:`);
      for (const w of written) console.log("  " + w);
    }
    if (refreshAgentsDoc(dest, TEMPLATES(), packageVersion())) {
      console.log(`  ${join(dest, "AGENTS.md")}`);
    }
    ensureGitignored(target, `${dir}/.env`);
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
  .option("--no-probe", "Skip proving the verify commands in a cold worktree")
  .action(async (opts: { probe?: boolean }) => {
    const dir = crewDirName();
    const target = scaffoldTarget();
    const dest = join(target, dir);
    if (!existsSync(join(dest, "config.yaml"))) {
      copyNoOverwrite(TEMPLATES(), dest);
      console.log(`Scaffolded generic ${dir}/ templates first.\n`);
    }
    refreshAgentsDoc(dest, TEMPLATES(), packageVersion());
    const cfg = loadConfig(target);
    await runSetup(cfg);
    console.log("\nChecking prerequisites:");
    await runDoctor(cfg, logger);

    // Re-read: the onboarding agent just rewrote config.yaml, so the in-memory
    // cfg predates the verify commands we're about to prove.
    if (opts.probe === false) {
      console.log(
        "\nSkipped the cold-worktree verify check. Run it before your first cycle:\n" +
          "  crew probe",
      );
    } else {
      await probeVerify(loadConfig(target));
    }
  });

/**
 * Offer the cold-worktree probe at the end of `crew doctor`.
 *
 * Asked rather than run outright because it executes the project's real setup +
 * verify commands, which can take minutes — but it is asked at all because a
 * verify that only passes in the user's warm checkout breaks every agent cycle,
 * and that is not something to leave behind an undiscoverable flag.
 *
 * Never prompts without a TTY: in CI or a pipe there is nobody to answer, and
 * blocking there would hang the run.
 */
async function askProbe(
  cfg: CrewConfig,
  opts: { explicit?: boolean; suppressed?: boolean },
): Promise<boolean> {
  const decision = probeDecision({
    explicit: opts.explicit,
    suppressed: opts.suppressed,
    interactive: !!process.stdin.isTTY,
    verifyCount: Object.keys(cfg.gates.verify ?? {}).length,
  });
  if (decision === "run") return true;
  if (decision === "skip") return false;
  if (decision === "notice") {
    console.log(
      "\nNot checked: whether gates.verify passes in a cold worktree, where agents\n" +
        "run it. Run `crew probe` (several minutes) before your first cycle.",
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      "\nOne thing this can't tell from here: whether your verify commands pass in a\n" +
        "COLD worktree. Your checkout has generated code and build output that git\n" +
        "doesn't track — agents never get those, so a check that passes for you can\n" +
        "fail on every single run.",
    );
    const answer = (
      await rl.question("Prove them now? Runs your real commands, can take minutes. [y/N]: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    console.log("Skipped. Run it any time with: crew probe");
    return false;
  } finally {
    rl.close();
  }
}

program
  .command("probe")
  .description("Prove gates.setup + gates.verify pass in a cold worktree (where agents run them)")
  .action(async () => {
    const cfg = loadConfig();
    const result = await probeVerify(cfg);
    if (!result.ok) process.exit(1);
  });

program
  .command("doctor")
  .description("Check that the tools and secrets your configured providers need are present")
  .option(
    "--verify-worktree",
    "Also prove gates.setup + gates.verify pass in a cold worktree (same as: crew probe)",
  )
  .option("--no-probe", "Never offer to run the cold-worktree check (for scripts and CI)")
  .action(async (opts: { verifyWorktree?: boolean; probe?: boolean }) => {
    const cfg = loadConfig();
    if (refreshAgentsDoc(cfg.configDir, TEMPLATES(), packageVersion())) {
      console.log(`Updated ${join(cfg.configDir, "AGENTS.md")} for this crew version.\n`);
    }
    console.log("Prerequisites:");
    const ok = await runDoctor(cfg, logger);

    // This runs the project's real setup + verify commands, which can take
    // minutes — so it is never silently part of a doctor run. But a verify that
    // only passes in the user's warm checkout breaks EVERY agent cycle, and the
    // check that catches it was previously reachable only via a flag on this
    // command. So when nobody asked either way, ask.
    if (await askProbe(cfg, { explicit: opts.verifyWorktree, suppressed: opts.probe === false })) {
      const result = await probeVerify(cfg);
      if (!result.ok) process.exit(1);
    }
    // Advisory, and only worth attempting once the credentials above passed —
    // it needs a live tracker. A failure here never changes the exit code.
    if (ok) {
      try {
        const ports = await buildPorts(cfg);
        await checkLabelGate(cfg, ports.tracker);
      } catch (e) {
        logger.warn(`skipped the label-gate check: ${String(e).split("\n")[0]}`);
      }
    }
    process.exit(ok ? 0 : 1);
  });

program
  .command("status")
  .description("Print backlog / WIP counts and a config summary")
  .action(async () => {
    const cfg = loadConfig();
    const ports = await buildPorts(cfg);
    const [backlog, inProgress] = await Promise.all([
      ports.tracker.countBacklog(),
      ports.tracker.countInProgress(),
    ]);
    const agents = Object.values(ports.agents).sort((a, b) => a.name.localeCompare(b.name));
    console.log(`project:      ${cfg.project}`);
    console.log(`repo:         ${cfg.repo.path} (base ${cfg.repo.baseBranch})`);
    const scope = cfg.tracker.provider === "jira" ? "component" : "project";
    const team = cfg.tracker.provider === "jira" ? "project" : "team";
    console.log(
      `tracker:      ${cfg.tracker.provider} — ${team}: ${cfg.tracker.team}` +
        `${cfg.tracker.project ? ` / ${scope}: ${cfg.tracker.project}` : ""}`,
    );
    console.log(`forge:        ${forgeSummary(cfg)}`);
    console.log(`agent CLI:    ${agentSummary(cfg)}`);
    console.log(`backlog:      ${backlog}   (cap ${cfg.triager.backlogCap})`);
    console.log(`in progress:  ${inProgress} (WIP cap ${cfg.gates.wipCap})`);
    if (cfg.worktrees.reuse) {
      const slots = poolStatus(worktreeRootFor(cfg.repo.path), cfg.worktrees.max);
      const count = (s: string) => slots.filter((x) => x.state === s).length;
      console.log(
        `worktrees:    ${cfg.worktrees.max} pooled — ` +
          `${count("free")} free, ${count("busy")} busy, ${count("retained")} retained` +
          `${count("retained") ? "   (see: crew worktrees)" : ""}`,
      );
    }
    console.log(`agents:       ${agents.map((a) => a.name).join(", ") || "(none found)"}`);
    const stuck = stuckItems(cfg);
    if (stuck.length) {
      const abandoned = stuck.filter((s) => s.state === "abandoned").length;
      console.log("");
      console.log(
        `in flight:    ${stuck.length}` +
          (abandoned ? `   ${abandoned} abandoned by a died run` : ""),
      );
      for (const line of formatStuck(stuck)) console.log(line);
      if (abandoned) {
        console.log(
          `  an abandoned item is picked up again the next time it is selected;\n` +
            `  clear one by hand with: crew unclaim <id>`,
        );
      }
    }
    console.log("");
    printSchedule(agents);
    console.log("");
    console.log(`log file:     ${logFilePath(cfg.configDir)}`);
    console.log(`run sooner:   crew once <agent>        (see: crew agents)`);
  });

program
  .command("tui", { isDefault: true })
  .description(
    "Run the whole team on a live screen: executor loop + proposers on their cadence (default command)",
  )
  .option(
    "-v, --verbose",
    "trace every render to <configDir>/logs/tui-debug.log (for diagnosing flicker)",
  )
  .action(async (opts: { verbose?: boolean }) => {
    const cfg = loadConfig();
    // Quiet: warn to the log file on missing prereqs (OAuth logins included)
    // and continue — the header now surfaces OAuth login state live, so this
    // is a startup nudge into the log, not a gate.
    await runDoctor(cfg, logger, true);
    const { runTui } = await import("../tui/index.js");
    const { debugFilePath } = await import("../tui/debug.js");
    await runTui(cfg, opts.verbose === true);
    // Printed after the TUI has released the screen, so it survives on the
    // terminal instead of being erased with the last frame.
    if (opts.verbose) console.log(`render trace: ${debugFilePath(cfg.configDir)}`);
  });

const worktreeCmd = program
  .command("worktrees")
  .description("Inspect and manage the reusable worktree pool (worktrees.reuse)");

worktreeCmd
  .command("list", { isDefault: true })
  .description("Show every pool slot, its state, and the branch it holds")
  .action(() => {
    const cfg = loadConfig();
    if (!cfg.worktrees.reuse) {
      console.log(
        "worktree reuse is off — every cycle gets a fresh worktree.\n" +
          "Enable it with `worktrees.reuse: true` in your config.yaml if a cold\n" +
          "checkout plus gates.setup is costing you real time each cycle.",
      );
      return;
    }
    const dir = worktreeRootFor(cfg.repo.path);
    const slots = poolStatus(dir, cfg.worktrees.max);
    console.log(`pool:  ${dir}`);
    console.log(
      `slots: ${cfg.worktrees.max}   deep clean every ${
        cfg.worktrees.recycleAfter || "never"
      } uses\n`,
    );
    for (const s of slots) {
      const held = s.branch ? `  ${s.branch}` : "";
      const age = s.acquiredAt ? `  since ${s.acquiredAt}` : "";
      console.log(
        `  slot-${s.slot}  ${s.state.padEnd(9)} uses=${String(s.useCount).padStart(3)}${held}${age}`,
      );
    }
    const retained = slots.filter((s) => s.state === "retained");
    if (retained.length) {
      console.log(
        `\n${retained.length} slot(s) retained: each holds a verified commit that could not be\n` +
          `pushed, or work that needs a human. They stay out of the pool until resolved.\n` +
          `Inspect the branch, then: crew worktrees release <slot>`,
      );
    }

    // A retained slot says a slot is held; this says which item is behind it
    // and why — the question you actually have when you run this command.
    const stuck = stuckItems(cfg);
    if (stuck.length) {
      console.log(`\nin flight:`);
      for (const line of formatStuck(stuck)) console.log(line);
    }
  });

worktreeCmd
  .command("release")
  .argument("<slot>", "slot number, e.g. 0")
  .option("--destroy", "also delete the checkout, so the next use starts cold")
  .description("Force a slot back into the pool (discards any work it holds)")
  .action((slotArg: string, opts: { destroy?: boolean }) => {
    const cfg = loadConfig();
    const slot = Number.parseInt(slotArg, 10);
    if (!Number.isInteger(slot) || slot < 0 || slot >= cfg.worktrees.max) {
      console.error(`slot must be between 0 and ${cfg.worktrees.max - 1}`);
      process.exitCode = 1;
      return;
    }
    const dir = worktreeRootFor(cfg.repo.path);
    const meta = poolStatus(dir, cfg.worktrees.max)[slot];
    if (meta.state === "retained") {
      console.log(
        `slot-${slot} holds ${meta.branch ?? "work"} that was never landed. ` +
          `Releasing it discards that work.`,
      );
    }
    if (opts.destroy) destroySlot(dir, slot);
    releaseSlot(dir, slot, false);
    console.log(`slot-${slot} released${opts.destroy ? " and destroyed" : ""}.`);
  });

worktreeCmd
  .command("warm")
  .description("Create every pool slot up front, so the first cycles don't pay for a cold checkout")
  .action(async () => {
    const cfg = loadConfig();
    if (!cfg.worktrees.reuse) {
      console.error("worktree reuse is off; nothing to warm. Set worktrees.reuse: true first.");
      process.exitCode = 1;
      return;
    }
    const git = new GitAdapter(cfg.repo.path, cfg.repo.baseBranch, undefined, {
      max: cfg.worktrees.max,
      preserveArtifacts: cfg.worktrees.preserveArtifacts,
      recycleAfter: cfg.worktrees.recycleAfter,
    });
    const dir = worktreeRootFor(cfg.repo.path);
    console.log(`Warming ${cfg.worktrees.max} slot(s) under ${dir}`);
    console.log("On a large repo the first checkout of each slot takes a while.\n");
    await git.syncBase();

    // Claim every slot, then release them all: claiming is what materializes a
    // checkout, and doing it here means cycle #1 doesn't discover the cost.
    const claimed: string[] = [];
    for (let i = 0; i < cfg.worktrees.max; i++) {
      const started = Date.now();
      const wt = await git.createWorktree(`crew/warm-${i}`);
      claimed.push(wt);
      console.log(`  ${wt}  (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    for (const wt of claimed) await git.removeWorktree(wt);
    console.log(`\nDone. ${claimed.length} slot(s) ready.`);
    if (cfg.gates.setup) {
      console.log(
        `\nNote: gates.setup ("${cfg.gates.setup}") still runs on the first cycle in each\n` +
          `slot. Its output is what later cycles reuse.`,
      );
    }
  });

program
  .command("unclaim")
  .argument("[id]", "issue identifier, e.g. ABC-1; omit to list what is held")
  .option("--all-stale", "release every claim whose owning process is gone")
  .option("--reset", "also clear the retry counters and any pending verify fix")
  .description("Release an in-flight claim so the item can be picked up again")
  .action((id: string | undefined, opts: { allStale?: boolean; reset?: boolean }) => {
    const cfg = loadConfig();
    const held = stuckItems(cfg);

    if (!id && !opts.allStale) {
      if (!held.length) {
        console.log("Nothing is claimed.");
        return;
      }
      console.log(`${held.length} item(s) in flight:\n`);
      for (const line of formatStuck(held)) console.log(line);
      console.log(`\nRelease one with: crew unclaim <id>`);
      return;
    }

    const targets = opts.allStale
      ? held.filter((h) => h.state === "abandoned").map((h) => h.identifier)
      : [id as string];
    if (!targets.length) {
      console.log("No abandoned claims to release.");
      return;
    }

    for (const t of targets) {
      const known = listClaims(cfg.configDir).some((c) => c.identifier === t);
      // A live worker's claim is releasable on purpose — that is the escape
      // hatch when a run wedges — but it must be said out loud, since the
      // worker will keep going and could still push.
      const live = held.find((h) => h.identifier === t && h.state === "working");
      if (live) {
        console.log(
          `warning: ${t} is claimed by a RUNNING worker (pid ${live.claim?.pid ?? "?"}). ` +
            `Releasing it lets a second worker take the same item.`,
        );
      }
      releaseClaim(cfg.configDir, t);
      if (opts.reset) {
        setVerifyAttempts(cfg.configDir, t, 0);
        setResumeAttempts(cfg.configDir, t, 0);
        clearVerifyFailure(cfg.configDir, t);
      }
      console.log(
        known
          ? `${t}: claim released${opts.reset ? " and retry state cleared" : ""}.`
          : `${t}: no claim was held${opts.reset ? "; retry state cleared" : ""}.`,
      );
    }

    if (opts.reset) {
      console.log(
        `\nNote: --reset discards the record of a failed verification, so the next\n` +
          `run starts the item over rather than fixing the existing commit.`,
      );
    }
  });

program
  .command("once")
  .argument("<agent>", "any agent name — see `crew agents`")
  .description("Run a single cycle of one agent (what cron fires on cadence)")
  .action(async (name: PersonaName) => {
    const cfg = loadConfig();

    // Resolve the agent from disk BEFORE building ports, so a typo fails
    // instantly instead of behind a tracker credentials error.
    const def = loadAgents(cfg).find((a) => a.name === name);
    if (!def) {
      const known = discoverPersonaFiles(cfg).join(", ") || "(none)";
      console.error(`Unknown agent "${name}". Defined agents: ${known}`);
      console.error(`Add one with: crew agent new ${name}`);
      process.exit(1);
    }
    if (def.kind === "reviewer") {
      console.error(
        `"${name}" is a reviewer — it runs automatically after a PR is opened, ` +
          `not as a standalone cycle.`,
      );
      process.exit(1);
    }

    logToFile(logFilePath(cfg.configDir));
    const ports = await buildPorts(cfg);
    const outcome =
      def.kind === "executor"
        ? await implementerCycle(cfg, ports, logger)
        : await proposerCycle(cfg, ports, def, logger);
    console.log(JSON.stringify(outcome, null, 2));
  });

program
  .command("drain")
  .argument("<agent>", "a proposer with `mode: drain` — see `crew agents`")
  .description(
    "Run a drain agent to completion: propose, wait for the executor, repeat until its doneWhen check passes or nothing new gets filed",
  )
  .action(async (name: PersonaName) => {
    const cfg = loadConfig();
    const def = loadAgents(cfg).find((a) => a.name === name);
    if (!def) {
      const known = discoverPersonaFiles(cfg).join(", ") || "(none)";
      console.error(`Unknown agent "${name}". Defined agents: ${known}`);
      process.exit(1);
    }
    if (def.mode !== "drain") {
      console.error(
        `"${name}" is not a drain agent. Add \`mode: drain\` (and ideally a \`doneWhen\` ` +
          `completion check) to its frontmatter or config.yaml entry, or run one cycle ` +
          `with: crew once ${name}`,
      );
      process.exit(1);
    }

    logToFile(logFilePath(cfg.configDir));
    const ports = await buildPorts(cfg);
    const outcome = await runDrainSession(cfg, ports, def, logger);
    console.log(JSON.stringify(outcome, null, 2));
    process.exit(outcome.status === "error" ? 1 : 0);
  });

program
  .command("agents")
  .description("List every agent defined for this repo, its kind, cadence, and options")
  .action(() => {
    const cfg = loadConfig();
    const agents = loadAgents(cfg).sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
    if (!agents.length) {
      console.log(`No agents found in ${personasDir(cfg)}.`);
      console.log("Create one with: crew agent new <name>");
      return;
    }

    for (const kind of ["proposer", "executor", "reviewer"] as AgentKind[]) {
      const group = agents.filter((a) => a.kind === kind);
      if (!group.length) continue;
      console.log(`\n${kind}s:`);
      for (const a of group) {
        const when =
          kind === "executor"
            ? "continuous"
            : kind === "reviewer"
              ? "on-pr"
              : a.mode === "drain"
                ? "drain (manual)"
                : a.cadence || "(no cadence — never scheduled)";
        const next = a.cadence && a.cadence !== "continuous" ? nextRunFor(a.cadence) : null;
        console.log(
          `  ${a.name.padEnd(16)} ${when.padEnd(16)}` +
            `${a.builtin ? "" : "custom  "}${next ? `next: ${next.toLocaleString()}` : ""}`,
        );
        if (a.description) console.log(`  ${"".padEnd(16)} ${a.description}`);
        const opts: string[] = [];
        if (a.model) opts.push(`model=${a.model}`);
        if (a.allowedTypes?.length) opts.push(`types=${a.allowedTypes.join("/")}`);
        if (a.maxProposals) opts.push(`max=${a.maxProposals}`);
        if (a.mode === "drain") {
          if (a.doneWhen) opts.push(`doneWhen=\`${a.doneWhen}\``);
          if (a.maxInProgress) opts.push(`maxInProgress=${a.maxInProgress}`);
          if (a.maxIterations) opts.push(`maxIterations=${a.maxIterations}`);
        }
        if (a.label) opts.push(`label=${a.label}`);
        if (a.claims?.length) opts.push(`claims=${a.claims.join("/")}`);
        if (a.canTransitionTo?.length) opts.push(`canMoveTo=${a.canTransitionTo.join("/")}`);
        if (a.mcp?.length) opts.push(`mcp=${a.mcp.join("/")}`);
        if (opts.length) console.log(`  ${"".padEnd(16)} ${opts.join("  ")}`);
      }
    }

    if (!agentsOfKind(agents, "executor").length) {
      console.log(
        `\nWarning: no executor agent — nothing will implement work. ` +
          `Expected ${personasDir(cfg)}/implementer.md`,
      );
    }
    const orphans = orphanedConfigEntries(cfg);
    if (orphans.length) {
      console.log(
        `\nWarning: config.yaml lists ${orphans.join(", ")} with no matching ` +
          `personas/<name>.md — typo, or the file was deleted.`,
      );
    }
    console.log(`\nRun one now:  crew once <name>`);
  });

const agentCmd = program.command("agent").description("Manage agents");

agentCmd
  .command("add")
  .argument("[name]", "agent name (lowercase, hyphens); can also be decided during the conversation")
  .description("Launch Claude to conversationally design a new agent: goal, prompt, kind, cadence, MCP tools")
  .action(async (name: string | undefined) => {
    if (name && !isValidAgentName(name)) {
      console.error(
        `Invalid agent name "${name}". Use lowercase letters, digits and hyphens ` +
          `(e.g. "security-review"), 2-40 chars.`,
      );
      process.exit(1);
    }
    const cfg = loadConfig();
    const dir = personasDir(cfg);
    if (name && existsSync(join(dir, `${name}.md`))) {
      console.error(`${join(dir, `${name}.md`)} already exists — edit it directly.`);
      process.exit(1);
    }

    const promptPath = fileURLToPath(new URL("../../templates/add-agent.md", import.meta.url));
    let prompt = readFileSync(promptPath, "utf8");
    if (name) {
      prompt += `\n\nThe user already chose the name "${name}" for this agent — write it to ` +
        `\`.crew/personas/${name}.md\` (don't ask for a different name unless they want to change it).\n`;
    }

    const before = new Set(discoverPersonaFiles(cfg));
    await launchInteractiveAgent(cfg, cfg.agent, prompt);

    const after = discoverPersonaFiles(cfg).filter((n) => !before.has(n));
    if (after.length) {
      console.log(`\nCreated: ${after.map((n) => join(dir, `${n}.md`)).join(", ")}`);
      console.log(`See it listed:  crew agents`);
    } else {
      console.log(`\nNo new persona file found in ${dir} — nothing was created.`);
    }
  });

agentCmd
  .command("new")
  .argument("<name>", "agent name (lowercase, hyphens; becomes personas/<name>.md)")
  .option("-k, --kind <kind>", "proposer | executor | reviewer", "proposer")
  .option("-c, --cadence <cron>", "cron cadence for proposers", "0 9 * * 1")
  .option("-m, --model <model>", "model override (e.g. haiku, sonnet, opus)")
  .option("-d, --description <text>", "one-line description")
  .description("Scaffold a new agent from flags: writes personas/<name>.md with fill-in-the-blank frontmatter (see `crew agent add` for a guided, conversational version)")
  .action(
    (
      name: string,
      opts: { kind: string; cadence: string; model?: string; description?: string },
    ) => {
      const cfg = loadConfig();
      if (!isValidAgentName(name)) {
        console.error(
          `Invalid agent name "${name}". Use lowercase letters, digits and hyphens ` +
            `(e.g. "security-review"), 2-40 chars.`,
        );
        process.exit(1);
      }
      const kind = opts.kind as AgentKind;
      if (!["proposer", "executor", "reviewer"].includes(kind)) {
        console.error(`Invalid --kind "${opts.kind}" (expected proposer | executor | reviewer)`);
        process.exit(1);
      }

      const dir = personasDir(cfg);
      const file = join(dir, `${name}.md`);
      if (existsSync(file)) {
        console.error(`${file} already exists — edit it directly.`);
        process.exit(1);
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, agentTemplate(name, kind, opts), "utf8");

      console.log(`Created ${file}`);
      console.log(
        `\nIt is live now — settings come from the frontmatter, so no config.yaml\n` +
          `edit is needed (you can still override them there).\n`,
      );
      console.log(`Next:`);
      console.log(`  1. Edit ${file} — describe what this agent should do.`);
      if (kind === "proposer") console.log(`  2. Try it:  crew once ${name}`);
      else if (kind === "executor")
        console.log(`  2. Set \`claims:\` to the labels it should pick up, then: crew`);
      else console.log(`  2. It runs automatically after the next PR is opened.`);
      console.log(`  3. See it listed:  crew agents`);
    },
  );

/** Frontmatter + starter prompt for a new agent, tailored to its kind. */
function agentTemplate(
  name: string,
  kind: AgentKind,
  opts: { cadence: string; model?: string; description?: string },
): string {
  const fm: string[] = [`kind: ${kind}`];
  if (kind === "proposer") fm.push(`cadence: "${opts.cadence}"`);
  if (opts.model) fm.push(`model: ${opts.model}`);
  fm.push(`description: "${opts.description ?? `Custom ${kind} agent`}"`);

  if (kind === "proposer") {
    fm.push(
      `# Only file these item types (omit to allow all):`,
      `# allowedTypes: [bug, task]`,
      `# Cap how many items one run may file:`,
      `# maxProposals: 5`,
      `# Tag everything this agent files, so you can filter it on your board:`,
      `# label: "agent:${name}"`,
    );
  } else if (kind === "executor") {
    fm.push(
      `# Work items carrying any of these labels route to this agent instead of`,
      `# the implementer. Unclaimed work still goes to the implementer.`,
      `claims: []`,
    );
  } else {
    fm.push(
      `# Workflow states this reviewer may move the issue to. Empty = comments`,
      `# only. The engine refuses anything not listed here.`,
      `# canTransitionTo: ["Todo", "In Review"]`,
    );
  }

  fm.push(
    `# External tool servers to grant, by name from the mcpServers: block in`,
    `# config.yaml. Omit for none — tools are never inherited from your own`,
    `# Claude Code / Codex config.`,
    `# mcp: [sentry]`,
  );

  const body =
    kind === "proposer"
      ? `You are the **${name}** agent. You are READ-ONLY: never modify code.

Describe here what this agent should look for and what it should file. Be
specific about where to look and what counts as worth filing — a vague prompt
produces vague issues.

For each finding, file a work item with real evidence (file:line, a failing
test name, a route). Set severity by how much it matters and complexity by how
hard the fix is. Only file things you are confident are real. Zero findings is
a fine answer.
`
      : kind === "executor"
        ? `You are the **${name}** agent. You implement one work item at a time in an
isolated git worktree.

Describe here what makes this agent different from the default implementer —
the kind of work it handles, the conventions it must follow, and anything it
should refuse to do.

Make exactly ONE atomic commit, or no commit if you cannot complete the task
cleanly. The runner handles pushing and opening the PR.
`
        : `You are the **${name}** agent. You review pull requests opened by the team.
You are READ-ONLY and you perform no actions yourself — you return a verdict and
the engine applies it.

Describe here what this agent should check for on every PR: the specific risks,
conventions, or regressions it owns. Be concrete about what should block versus
what is just a comment.

Cite file:line in your comments. If the change looks good, say so briefly
rather than inventing objections.
`;

  return `---\n${fm.join("\n")}\n---\n\n${body}`;
}

const mcpCmd = program.command("mcp").description("Manage OAuth for MCP servers defined under mcpServers:");

mcpCmd
  .command("login")
  .argument("<server>", "server name from mcpServers: in config.yaml")
  .description("Authorize an OAuth-protected MCP server interactively (opens a browser, one-time)")
  .action(async (server: string) => {
    const cfg = loadConfig();
    const def = cfg.mcpServers?.[server];
    if (!def) {
      console.error(
        `Unknown MCP server "${server}" (known: ${Object.keys(cfg.mcpServers ?? {}).join(", ") || "none"})`,
      );
      process.exit(1);
    }
    if (!def.oauth) {
      console.error(`mcpServers.${server} has no \`oauth:\` block — nothing to log in to.`);
      process.exit(1);
    }
    const { loginInteractive } = await import("../config/oauth.js");
    console.log(`Opening a browser to authorize "${server}"...`);
    try {
      await loginInteractive(server, def.oauth, {
        onUrl: (url) => console.log(`If it didn't open automatically, visit:\n  ${url}\n`),
      });
    } catch (e) {
      console.error(`Login failed: ${(e as Error).message}`);
      process.exit(1);
    }
    console.log(`Logged in. Token stored in ~/.crew/oauth/${server}.json — grant it to a persona with \`mcp: [${server}]\`.`);
  });

mcpCmd
  .command("logout")
  .argument("<server>", "server name from mcpServers: in config.yaml")
  .description("Forget the stored OAuth token for a server")
  .action((server: string) => {
    // No need for def/oauth to still be configured — this only clears local
    // state, so it works even after the server was renamed or removed.
    forgetToken(server);
    console.log(`Cleared any stored token for "${server}".`);
  });

mcpCmd
  .command("status", { isDefault: true })
  .description("Show which OAuth MCP servers are logged in")
  .action(() => {
    const cfg = loadConfig();
    const oauthServers = Object.entries(cfg.mcpServers ?? {}).filter(([, def]) => def.oauth);
    if (!oauthServers.length) {
      console.log("No mcpServers.* entries have an `oauth:` block.");
      return;
    }
    for (const [name] of oauthServers) {
      console.log(`  ${hasStoredToken(name) ? "✓" : "✗"} ${name}${hasStoredToken(name) ? "" : "   → crew mcp login " + name}`);
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});

// silence unused import in some tsc configs
void dirname;
