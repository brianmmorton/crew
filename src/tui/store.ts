import { proxy } from "valtio";
import { proxyMap } from "valtio/utils";
import type { Snapshot } from "./snapshot.js";
import type { AgentRun } from "./runManager.js";
import type { LogoArt } from "./logoArt.js";

/**
 * All TUI state in one valtio proxy, replacing the ~10 useState slots that
 * used to live in App.tsx. Every one of those forced a re-render of the
 * entire component tree on any change — a single new log line re-rendered
 * the header, agent list, and footer along with the log panel. With valtio,
 * each component subscribes (via useSnapshot) only to the slice it reads,
 * so a log line re-renders just LogPanel, a spinner tick re-renders just
 * the row showing it, and so on.
 */
export const store = proxy({
  snap: null as Snapshot | null,
  logLines: [] as string[],
  rows: 24,
  selected: 0,
  expanded: null as string | null,
  headerLogo: null as LogoArt | null,
  splashLogo: null as LogoArt | null,
  implPaused: false,
  // Native Map/Set are opaque to valtio (treated as an unproxied ref, see
  // valtio's SnapshotIgnore type) — mutations inside one are invisible to
  // subscribers. proxyMap() is valtio's own reactive Map that does track them.
  runs: proxyMap<string, AgentRun>(),
});

// Engine handles deliberately kept OUT of the proxy: nothing renders from
// them, and putting a Ports in the store would hand every tracker/git call
// a proxy-wrapped object (slower, and breaks identity comparisons inside
// the adapters).


export const MAX_LOG_LINES = 500;

export function appendLogLines(lines: string[]): void {
  if (!lines.length) return;
  store.logLines = [...store.logLines, ...lines].slice(-MAX_LOG_LINES);
}

/**
 * The parts of a snapshot that are actually on screen. The poller rebuilds a
 * whole Snapshot every tick, so assigning it unconditionally hands valtio a
 * new object reference each time and re-renders the dashboard once a second
 * whether or not anything moved. Comparing the visible fields lets an
 * unchanged tick be dropped entirely.
 */
function visibleShape(s: Snapshot): string {
  return JSON.stringify([
    s.backlog,
    s.inProgress,
    s.supervisorAlive,
    s.error,
    s.slots?.map((x) => [x.slot, x.state]) ?? null,
    s.agentRows.map((r) => [r.agent.name, r.agent.kind, r.next?.getTime() ?? null]),
    s.stuck.map((x) => [x.identifier, x.state, x.verifyTries, x.landTries, x.reason]),
    s.mcpOAuth.map((x) => [x.server, x.loggedIn]),
  ]);
}

/**
 * Publish a snapshot, skipping the write when nothing visible changed.
 * Returns whether the store was actually updated.
 */
export function publishSnapshot(next: Snapshot): boolean {
  if (store.snap && visibleShape(store.snap) === visibleShape(next)) return false;
  store.snap = next;
  return true;
}

/**
 * Set when local state shows work moved — an agent run finishing, a worktree
 * slot freeing up, the set of claims changing — so the next poll re-reads the
 * tracker instead of waiting out its staleness ceiling. This is the "refresh
 * when needed" path; the timed refresh is only a backstop for changes made by
 * another process.
 *
 * Deliberately a plain module flag rather than part of the proxy: nothing
 * renders from it, and it's written from places (RunManager's child-process
 * handlers) that must not trigger a re-render.
 */
let trackerDirty = false;

export function invalidateTrackerCounts(): void {
  trackerDirty = true;
}

/** Read and clear the flag. */
export function takeTrackerDirty(): boolean {
  const was = trackerDirty;
  trackerDirty = false;
  return was;
}

/**
 * Return the store to its initial state. The store is a module singleton, so
 * tests and stories that render more than one state in a process have to
 * reset between them or state leaks from one case into the next.
 */
export function resetStore(): void {
  store.snap = null;
  store.logLines = [];
  store.rows = 24;
  store.selected = 0;
  store.expanded = null;
  store.headerLogo = null;
  store.splashLogo = null;
  store.implPaused = false;
  store.runs.clear();
}
