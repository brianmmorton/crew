import { spawn, type ChildProcess } from "node:child_process";
import type { PersonaName } from "../types.js";
import { appendAgentLines } from "./stores/feed.js";
import {
  appendRunOutput,
  beginRun,
  runsStore,
  setRunStatus,
} from "./stores/runs.js";
import { invalidateTrackerCounts } from "./stores/pool.js";

/**
 * Manual agent runs. Each is `crew once <agent>` (or `crew drain <agent>` for
 * a run-to-completion drain session) as a child process, re-exec'd with the
 * same node binary + entry script the TUI was launched with
 * (process.execPath / process.argv[1]) so it works identically against
 * dist/cli/index.js and tsx-run source, without `crew` on PATH.
 *
 * Output is written to BOTH stores/runs (the agent's expanded pane) and
 * stores/feed (the unified panel), tagged with the agent name. One live run
 * per agent — pressing run again while one is in flight is a no-op.
 *
 * Pause is real: SIGSTOP freezes the whole child (and its own children,
 * spawned in the same process group won't be — but the claude CLI child gets
 * no more stdin/stdout progress and the OS stops scheduling the process).
 * SIGCONT resumes exactly where it stopped.
 */

const procs = new Map<PersonaName, ChildProcess>();

export function isRunning(agent: PersonaName): boolean {
  return procs.has(agent);
}

export function startRun(agent: PersonaName, verb: "once" | "drain" = "once"): void {
  if (procs.has(agent)) return;

  beginRun(agent);
  const child = spawn(process.execPath, [process.argv[1] ?? "", verb, agent], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  procs.set(agent, child);

  const onData = (chunk: Buffer) => {
    const lines = chunk
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    appendRunOutput(agent, lines);
    appendAgentLines(agent, lines);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  child.on("error", (err) => {
    appendRunOutput(agent, [`[tui] failed to start: ${err.message}`]);
    setRunStatus(agent, "failed");
    procs.delete(agent);
  });

  child.on("exit", (code) => {
    setRunStatus(agent, code === 0 ? "done" : "failed", code);
    procs.delete(agent);
    // A finished cycle is the most likely moment for backlog/wip to have
    // moved — pull the next tracker read forward.
    invalidateTrackerCounts();
  });
}

/** Freeze / thaw a live run with SIGSTOP / SIGCONT. No-op when not live. */
export function toggleRunPause(agent: PersonaName): void {
  const child = procs.get(agent);
  if (!child) return;
  const meta = runsStore.byAgent[agent];
  if (meta?.status === "paused") {
    child.kill("SIGCONT");
    setRunStatus(agent, "running");
  } else if (meta?.status === "running") {
    child.kill("SIGSTOP");
    setRunStatus(agent, "paused");
  }
}

/** Best-effort stop; the exit handler settles final state. */
export function stopRun(agent: PersonaName): void {
  const child = procs.get(agent);
  if (!child) return;
  // A SIGSTOPped process can't handle SIGTERM until it's continued.
  child.kill("SIGCONT");
  child.kill("SIGTERM");
}

export function stopAllRuns(): void {
  for (const agent of [...procs.keys()]) stopRun(agent);
}
