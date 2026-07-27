import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Small persisted state so restarts don't re-flood proposers. */
export interface CrewState {
  lastRun: Record<string, string>; // persona -> ISO timestamp of last completed run
  pid?: number;
  startedAt?: string;
  /**
   * Item identifier -> how many times a preserved worktree has been resumed
   * without succeeding. Bounds retries so a permanently-broken push can't loop
   * or leak worktrees forever.
   */
  resumeAttempts?: Record<string, number>;
}

/** Max times a preserved worktree is resumed before it's discarded. */
export const MAX_RESUME_ATTEMPTS = 3;

/** Read the resume-attempt count for an item. */
export function resumeAttempts(configDir: string, identifier: string): number {
  return readState(configDir).resumeAttempts?.[identifier] ?? 0;
}

/** Set (or clear, with 0) the resume-attempt count for an item. */
export function setResumeAttempts(
  configDir: string,
  identifier: string,
  n: number,
): void {
  const s = readState(configDir);
  const counts = { ...(s.resumeAttempts ?? {}) };
  if (n <= 0) delete counts[identifier];
  else counts[identifier] = n;
  writeState(configDir, { ...s, resumeAttempts: counts });
}

/** <configDir>/state.json (override CREW_STATE_DIR). */
export function statePath(configDir: string): string {
  const dir = process.env.CREW_STATE_DIR?.trim() || configDir;
  return join(dir, "state.json");
}

export function readState(configDir: string): CrewState {
  try {
    const p = statePath(configDir);
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CrewState>;
      return {
        lastRun: parsed.lastRun ?? {},
        pid: parsed.pid,
        startedAt: parsed.startedAt,
        resumeAttempts: parsed.resumeAttempts ?? {},
      };
    }
  } catch {
    /* ignore corrupt/missing state */
  }
  return { lastRun: {} };
}

/**
 * Persist state, merging `resumeAttempts` from disk when the caller didn't set
 * it. The supervisor holds a long-lived CrewState and writes it after each
 * proposer run; the executor loop updates resume counts independently. Without
 * this merge the supervisor's stale copy would silently erase them.
 */
export function writeState(configDir: string, s: CrewState): void {
  try {
    const p = statePath(configDir);
    mkdirSync(dirname(p), { recursive: true });
    const next = s.resumeAttempts
      ? s
      : { ...s, resumeAttempts: readState(configDir).resumeAttempts ?? {} };
    writeFileSync(p, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
}
