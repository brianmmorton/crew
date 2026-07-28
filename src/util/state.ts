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
  /**
   * Item identifier -> how many times the agent has been sent back in to fix a
   * failing verify. Deliberately separate from `resumeAttempts`: a shared
   * budget would let fix-forward exhaust the retries that landing needs, so an
   * item that finally goes green would have nothing left to push with.
   */
  verifyAttempts?: Record<string, number>;
}

/** Max times a preserved worktree is resumed before it's discarded. */
export const MAX_RESUME_ATTEMPTS = 3;

/**
 * Max times the agent is sent back to fix a failing verify before the item is
 * demoted. Kept low on purpose: each attempt holds a pool slot for a full agent
 * run, and an agent that hasn't fixed its own test failure in two tries is
 * usually confused rather than close.
 */
export const MAX_VERIFY_ATTEMPTS = 2;

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

/** Read the verify fix-forward attempt count for an item. */
export function verifyAttempts(configDir: string, identifier: string): number {
  return readState(configDir).verifyAttempts?.[identifier] ?? 0;
}

/** Set (or clear, with 0) the verify fix-forward attempt count for an item. */
export function setVerifyAttempts(
  configDir: string,
  identifier: string,
  n: number,
): void {
  const s = readState(configDir);
  const counts = { ...(s.verifyAttempts ?? {}) };
  if (n <= 0) delete counts[identifier];
  else counts[identifier] = n;
  writeState(configDir, { ...s, verifyAttempts: counts });
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
        verifyAttempts: parsed.verifyAttempts ?? {},
      };
    }
  } catch {
    /* ignore corrupt/missing state */
  }
  return { lastRun: {} };
}

/**
 * Persist state, merging the per-item attempt counters from disk when the
 * caller didn't set them. The supervisor holds a long-lived CrewState and
 * writes it after each proposer run; the executor loop updates the counters
 * independently. Without this merge the supervisor's stale copy would silently
 * erase them — and a lost counter means an unbounded retry loop.
 */
export function writeState(configDir: string, s: CrewState): void {
  try {
    const p = statePath(configDir);
    mkdirSync(dirname(p), { recursive: true });
    // Read once: two readState() calls would double the I/O on every write.
    const onDisk =
      s.resumeAttempts && s.verifyAttempts ? null : readState(configDir);
    const next: CrewState = {
      ...s,
      resumeAttempts: s.resumeAttempts ?? onDisk?.resumeAttempts ?? {},
      verifyAttempts: s.verifyAttempts ?? onDisk?.verifyAttempts ?? {},
    };
    writeFileSync(p, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
}
