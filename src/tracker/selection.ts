import type { CrewConfig, EmptySelectionReason, ItemType, WorkItem } from "../types.js";

/** Item types the Implementer is allowed to execute directly. */
const EXECUTABLE_TYPES: ReadonlySet<ItemType> = new Set<ItemType>([
  "bug",
  "task",
  "chore-dx",
]);

/**
 * Apply the configured label gate. An empty `requireLabels` means "no
 * allowlist" rather than "nothing qualifies", so an unconfigured crew claims
 * everything it did before this gate existed. `excludeLabels` wins over
 * `requireLabels`: a "blocked" item stays blocked however else it's tagged.
 */
export function passesLabelFilter(item: WorkItem, cfg: CrewConfig): boolean {
  const gate = cfg.tracker.executable;
  if (!gate) return true;
  const labels = new Set(item.labels);
  if (gate.excludeLabels?.some((l) => labels.has(l))) return false;
  if (gate.requireLabels?.length && !gate.requireLabels.some((l) => labels.has(l))) {
    return false;
  }
  return true;
}

/**
 * True only when the item is in the configured `ready` state, is of an
 * executable type, passes the label gate, and is not blocked by an unapproved
 * parent PRD (parentApproved === false). A null or true parentApproved is OK.
 */
export function isExecutable(item: WorkItem, cfg: CrewConfig): boolean {
  if (item.stateName !== cfg.tracker.statuses.ready) return false;
  if (item.type === null || !EXECUTABLE_TYPES.has(item.type)) return false;
  if (item.parentApproved === false) return false;
  if (!passesLabelFilter(item, cfg)) return false;
  return true;
}

/** True when either label list is non-empty — i.e. the gate can reject anything. */
export function labelGateActive(cfg: CrewConfig): boolean {
  const gate = cfg.tracker.executable;
  return !!(gate?.requireLabels?.length || gate?.excludeLabels?.length);
}

/**
 * Summarize an empty selection: how many items were sitting in the ready state
 * (before the label gate) versus how many survived it. Adapters pass the
 * *unfiltered* ready page so the difference is attributable to the gate.
 */
export function explainEmpty(items: WorkItem[], cfg: CrewConfig): EmptySelectionReason {
  const gate = cfg.tracker.executable;
  return {
    ready: items.length,
    passedGate: items.filter((i) => passesLabelFilter(i, cfg)).length,
    requireLabels: gate?.requireLabels ?? [],
    excludeLabels: gate?.excludeLabels ?? [],
  };
}

/**
 * Effective priority ordering: urgent(1) > high(2) > normal(3) > low(4) > none(0).
 * Lower rank sorts first.
 */
function priorityRank(priority: number): number {
  switch (priority) {
    case 1:
      return 0; // urgent
    case 2:
      return 1; // high
    case 3:
      return 2; // normal
    case 4:
      return 3; // low
    default:
      return 4; // none (0) or unknown
  }
}

/**
 * Return a new array sorted by effective priority, tie-breaking by identifier
 * ascending. Does not mutate the input.
 */
export function rankCandidates(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    const ra = priorityRank(a.priority);
    const rb = priorityRank(b.priority);
    if (ra !== rb) return ra - rb;
    return a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0;
  });
}
