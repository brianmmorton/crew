import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Small persisted state so restarts don't re-flood proposers. */
export interface CrewState {
  lastRun: Record<string, string>; // persona -> ISO timestamp of last completed run
  pid?: number;
  startedAt?: string;
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
      return { lastRun: parsed.lastRun ?? {}, pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
    /* ignore corrupt/missing state */
  }
  return { lastRun: {} };
}

export function writeState(configDir: string, s: CrewState): void {
  try {
    const p = statePath(configDir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2));
  } catch {
    /* best-effort */
  }
}
