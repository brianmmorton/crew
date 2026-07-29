import { proxy } from "valtio";
import type { AgentKind, PersonaName } from "../../types.js";

/**
 * The agent panel's state: which agents exist, which row the cursor is on,
 * and which rows are expanded (accordion — any number may be open at once).
 *
 * `expanded` is a Record rather than a Set on purpose: valtio tracks per-key
 * access on plain objects, so a row reading `expanded[name]` re-renders only
 * when ITS key flips, not when a sibling expands. (Native Set/Map are opaque
 * to valtio's snapshot tracking.)
 */

export interface AgentItem {
  name: PersonaName;
  kind: AgentKind;
  cadence: string;
  description?: string;
  /** Next scheduled fire (epoch ms), null for continuous/unscheduled agents. */
  nextRun: number | null;
}

export const agentsStore = proxy({
  items: [] as AgentItem[],
  selected: 0,
  expanded: {} as Record<string, boolean>,
});

export function setAgents(items: AgentItem[]): void {
  agentsStore.items = items;
  if (agentsStore.selected >= items.length) {
    agentsStore.selected = Math.max(0, items.length - 1);
  }
}

export function moveSelection(delta: number): void {
  const n = agentsStore.items.length;
  if (n === 0) return;
  agentsStore.selected = Math.min(n - 1, Math.max(0, agentsStore.selected + delta));
}

export function selectedAgent(): AgentItem | null {
  return agentsStore.items[agentsStore.selected] ?? null;
}

export function toggleExpanded(name: PersonaName): void {
  agentsStore.expanded[name] = !agentsStore.expanded[name];
}

export function expandedCount(): number {
  return agentsStore.items.filter((a) => agentsStore.expanded[a.name]).length;
}

export function resetAgentsStore(): void {
  agentsStore.items = [];
  agentsStore.selected = 0;
  agentsStore.expanded = {};
}
