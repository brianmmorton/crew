/**
 * Conventions shared by every tracker adapter.
 *
 * These are part of crew's contract with the board, not with any one vendor: an
 * item filed by an agent is labeled the same way whether it lands in Linear or
 * Jira, so the same saved filters and the same dedup behaviour work on both.
 */

import type { Complexity, ItemType, Severity, TrackerConfig } from "../types.js";

/** Labels every agent-authored issue carries. */
export const AGENT_AUTHORED_LABEL = "agent-authored";

/** Prefix for the complexity label (e.g. "complexity:high"). */
export const COMPLEXITY_PREFIX = "complexity:";

/** Fallback dedup threshold when the config doesn't set one. */
export const DEDUP_THRESHOLD = 0.85;

/** Read a `complexity:*` label out of an issue's labels, or null if absent. */
export function complexityFromLabels(labels: readonly string[]): Complexity | null {
  for (const name of labels) {
    if (!name.startsWith(COMPLEXITY_PREFIX)) continue;
    const v = name.slice(COMPLEXITY_PREFIX.length);
    if (v === "low" || v === "medium" || v === "high") return v;
  }
  return null;
}

/**
 * Map a type:* label name back to an ItemType. Returns null for labels that
 * aren't one of the four configured type labels.
 */
export function labelNameToType(cfg: TrackerConfig, name: string): ItemType | null {
  const l = cfg.labels;
  if (name === l.prd) return "prd";
  if (name === l.bug) return "bug";
  if (name === l.task) return "task";
  if (name === l.chore) return "chore-dx";
  return null;
}

/**
 * The configured label name for a proposal type. "spike" deliberately reuses
 * the task label — a spike is a task with an uncertain outcome, and giving it
 * its own label would fragment every board filter for no gain.
 */
export function typeToLabelName(cfg: TrackerConfig, type: ItemType): string {
  const l = cfg.labels;
  switch (type) {
    case "prd":
      return l.prd;
    case "bug":
      return l.bug;
    case "task":
      return l.task;
    case "chore-dx":
      return l.chore;
    case "spike":
      return l.task;
  }
}

/**
 * Linear's numeric priority scale, which `WorkItem.priority` uses on every
 * provider: 0 none, 1 urgent, 2 high, 3 normal, 4 low. The Jira adapter
 * translates to and from named priorities on the way in and out.
 */
export function severityToPriority(severity: Severity | undefined): number {
  switch (severity) {
    case "critical":
      return 1;
    case "high":
      return 2;
    case "medium":
      return 3;
    case "low":
      return 4;
    default:
      return 0;
  }
}
