import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { Cron } from "croner";
import { buildPorts } from "../engine/ports.js";
import { agentsOfKind, scheduledAgents } from "../agent/agents.js";
import { poolStatus, worktreeRootFor, type SlotMeta } from "../git/pool.js";
import { stuckItems, type StuckItem } from "../engine/stuck.js";
import { readState } from "../util/state.js";
import { logFilePath } from "../util/logger.js";
import type { AgentDef, CrewConfig } from "../types.js";

/** One row in the agent panel: static definition plus its next/last fire time. */
export interface AgentRow {
  agent: AgentDef;
  next: Date | null;
}

/** Everything the screen redraws from, gathered in one pass. */
export interface Snapshot {
  cfg: CrewConfig;
  backlog: number;
  inProgress: number;
  slots: SlotMeta[] | null; // null when worktree reuse is off
  agentRows: AgentRow[];
  stuck: StuckItem[];
  supervisorAlive: boolean;
  logPath: string;
  error: string | null;
}

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

/**
 * Same liveness check the claim lock uses (signal 0), reused here to answer
 * "is the process behind state.json's pid actually running" for the header.
 */
function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One poll tick's worth of state, read fresh from disk each time. Deliberately
 * not incremental — every source here is a small JSON file or a handful of
 * worktree slot files, cheap enough to re-read whole rather than diff.
 */
export async function takeSnapshot(cfg: CrewConfig): Promise<Snapshot> {
  try {
    const ports = await buildPorts(cfg);
    const [backlog, inProgress] = await Promise.all([
      ports.tracker.countBacklog(),
      ports.tracker.countInProgress(),
    ]);
    const agents = Object.values(ports.agents).sort((a, b) => a.name.localeCompare(b.name));
    const agentRows: AgentRow[] = [
      ...scheduledAgents(agents)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((agent) => ({ agent, next: nextRunFor(agent.cadence) })),
      ...agentsOfKind(agents, "executor").map((agent) => ({ agent, next: null })),
      ...agentsOfKind(agents, "reviewer").map((agent) => ({ agent, next: null })),
    ];

    const slots = cfg.worktrees.reuse
      ? poolStatus(worktreeRootFor(cfg.repo.path), cfg.worktrees.max)
      : null;

    const state = readState(cfg.configDir);

    return {
      cfg,
      backlog,
      inProgress,
      slots,
      agentRows,
      stuck: stuckItems(cfg),
      supervisorAlive: pidAlive(state.pid),
      logPath: logFilePath(cfg.configDir),
      error: null,
    };
  } catch (e) {
    return {
      cfg,
      backlog: 0,
      inProgress: 0,
      slots: null,
      agentRows: [],
      stuck: [],
      supervisorAlive: false,
      logPath: logFilePath(cfg.configDir),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Tracks a byte offset into a growing log file so re-reads are incremental. */
export class LogTail {
  private offset = 0;
  private inode: number | null = null;

  constructor(private readonly path: string) {}

  /** New complete lines appended since the last call, oldest first. */
  read(): string[] {
    if (!existsSync(this.path)) return [];
    const st = statSync(this.path);
    // A rotated/truncated file has a smaller size or a new inode; start over
    // rather than seeking past the end or reading a stale offset into new data.
    if (st.ino !== this.inode || st.size < this.offset) {
      this.inode = st.ino;
      this.offset = Math.max(0, st.size - 64_000); // last ~64KB on first read
    }
    if (st.size === this.offset) return [];

    const fd = openSync(this.path, "r");
    try {
      const length = st.size - this.offset;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, this.offset);
      this.offset = st.size;
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // A partial trailing line (write in progress) is put back for next time.
      const partial = lines.pop() ?? "";
      this.offset -= Buffer.byteLength(partial, "utf8");
      return lines.filter((l) => l.length > 0);
    } finally {
      closeSync(fd);
    }
  }
}
