import { spawn, type ChildProcess } from "node:child_process";
import type { PersonaName } from "../types.js";
import { store, invalidateTrackerCounts } from "./store.js";

export type RunStatus = "running" | "exited" | "failed";

export interface AgentRun {
  agent: PersonaName;
  status: RunStatus;
  startedAt: Date;
  endedAt: Date | null;
  /** stdout+stderr interleaved, in arrival order — what an expanded view tails. */
  lines: string[];
  exitCode: number | null;
}

const MAX_RUN_LINES = 2000;

/**
 * Launches `crew once <agent>` as a child process and keeps its live output
 * and status in `store.runs`, keyed by agent name. One run per agent at a
 * time — pressing the key again while a run is live is a no-op rather than
 * a second concurrent cycle on the same agent.
 *
 * Re-execs with the same node binary and entry script the TUI itself was
 * launched with (`process.execPath` / `process.argv[1]`), so this works
 * identically against `dist/cli/index.js` (installed) and `tsx`-run source
 * (dev) without depending on `crew` being on PATH.
 *
 * Writes go straight into the valtio store rather than through a private
 * map plus a change-listener/notify pattern — valtio already batches
 * synchronous mutations into one notification per microtask, and only
 * components that actually read a given run's slice re-render on update.
 */
export class RunManager {
  private procs = new Map<PersonaName, ChildProcess>();

  get(agent: PersonaName): AgentRun | undefined {
    return store.runs.get(agent);
  }

  isRunning(agent: PersonaName): boolean {
    return store.runs.get(agent)?.status === "running";
  }

  start(agent: PersonaName): void {
    if (this.isRunning(agent)) return;

    store.runs.set(agent, {
      agent,
      status: "running",
      startedAt: new Date(),
      endedAt: null,
      lines: [],
      exitCode: null,
    });
    // Mutations must go through the value proxyMap.get() hands back, not the
    // object literal above — that literal is unwrapped and mutating it
    // directly would be invisible to useSnapshot subscribers.
    const run = () => store.runs.get(agent)!;

    const child = spawn(process.execPath, [process.argv[1] ?? "", "once", agent], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.procs.set(agent, child);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const newLines = text.split("\n").filter((l) => l.length > 0);
      if (!newLines.length) return;
      const r = run();
      r.lines = [...r.lines, ...newLines].slice(-MAX_RUN_LINES);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      const r = run();
      r.status = "failed";
      r.endedAt = new Date();
      r.lines = [...r.lines, `[tui] failed to start: ${err.message}`];
      this.procs.delete(agent);
    });

    child.on("exit", (code) => {
      const r = run();
      r.status = code === 0 ? "exited" : "failed";
      r.exitCode = code;
      r.endedAt = new Date();
      this.procs.delete(agent);
      // A finished cycle is the most likely moment for the backlog/wip counts
      // to have moved, so pull the next tracker read forward instead of
      // waiting out the staleness ceiling.
      invalidateTrackerCounts();
    });
  }

  /** Best-effort stop of a live run; the exit handler settles final state. */
  stop(agent: PersonaName): void {
    this.procs.get(agent)?.kill("SIGTERM");
  }

  stopAll(): void {
    for (const child of this.procs.values()) child.kill("SIGTERM");
  }
}
