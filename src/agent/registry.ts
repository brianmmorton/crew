import type { ChildProcess } from "node:child_process";

// Registry of live agent-CLI child processes, so a hotkey can kill the run.
const active = new Set<ChildProcess>();

export function register(c: ChildProcess): void {
  active.add(c);
}
export function unregister(c: ChildProcess): void {
  active.delete(c);
}

/** Kill all in-flight agent runs. Returns how many were signalled. */
export function killActiveRuns(): number {
  let n = 0;
  for (const c of active) {
    try {
      c.kill("SIGTERM");
      n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}
