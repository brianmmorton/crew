import { proxy } from "valtio";
import type { Session } from "../../util/runindex.js";

/**
 * Completed run history for the sidebar.
 *
 * `sessions` is rewritten only when the index file actually changes (bootstrap
 * gates on the file's size+mtime first), so the list keeps its identity across
 * the 1s poll and the sidebar doesn't re-render for nothing.
 *
 * Each session carries only its derived SUMMARY — a PR link, filed tickets, a
 * trimmed failure reason. Raw transcripts are deliberately not held in the
 * store; they stay on disk at the path in the run index.
 */

export const historyStore = proxy({
  sessions: [] as Session[],
  selected: 0,
});

export function setSessions(next: Session[]): void {
  historyStore.sessions = next;
  clampSelection();
}

/** Move the history cursor, clamped. Mirrors stores/agents' moveSelection. */
export function moveHistorySelection(delta: number): void {
  const count = historyStore.sessions.length;
  if (count === 0) return;
  historyStore.selected = Math.min(count - 1, Math.max(0, historyStore.selected + delta));
}

export function selectedSession(): Session | undefined {
  return historyStore.sessions[historyStore.selected];
}

function clampSelection(): void {
  const count = historyStore.sessions.length;
  historyStore.selected = count === 0 ? 0 : Math.min(historyStore.selected, count - 1);
}

export function resetHistoryStore(): void {
  historyStore.sessions = [];
  historyStore.selected = 0;
}
