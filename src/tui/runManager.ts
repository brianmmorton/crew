import { spawn, type ChildProcess } from "node:child_process";
import type { PersonaName } from "../types.js";

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
 * and status in memory, keyed by agent name. One run per agent at a time —
 * pressing the key again while a run is live is a no-op rather than a second
 * concurrent cycle on the same agent.
 *
 * Re-execs with the same node binary and entry script the TUI itself was
 * launched with (`process.execPath` / `process.argv[1]`), so this works
 * identically against `dist/cli/index.js` (installed) and `tsx`-run source
 * (dev) without depending on `crew` being on PATH.
 */
export class RunManager {
  private runs = new Map<PersonaName, AgentRun>();
  private procs = new Map<PersonaName, ChildProcess>();
  private listeners = new Set<() => void>();

  /** Subscribe to "something changed" — callers re-poll `get`/`all` themselves. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  get(agent: PersonaName): AgentRun | undefined {
    return this.runs.get(agent);
  }

  isRunning(agent: PersonaName): boolean {
    return this.runs.get(agent)?.status === "running";
  }

  start(agent: PersonaName): void {
    if (this.isRunning(agent)) return;

    const run: AgentRun = {
      agent,
      status: "running",
      startedAt: new Date(),
      endedAt: null,
      lines: [],
      exitCode: null,
    };
    this.runs.set(agent, run);

    const child = spawn(process.execPath, [process.argv[1] ?? "", "once", agent], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.procs.set(agent, child);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const newLines = text.split("\n").filter((l) => l.length > 0);
      if (!newLines.length) return;
      run.lines = [...run.lines, ...newLines].slice(-MAX_RUN_LINES);
      this.notify();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      run.status = "failed";
      run.endedAt = new Date();
      run.lines = [...run.lines, `[tui] failed to start: ${err.message}`];
      this.procs.delete(agent);
      this.notify();
    });

    child.on("exit", (code) => {
      run.status = code === 0 ? "exited" : "failed";
      run.exitCode = code;
      run.endedAt = new Date();
      this.procs.delete(agent);
      this.notify();
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
