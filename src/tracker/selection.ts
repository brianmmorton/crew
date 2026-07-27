import type { CrewConfig, ItemType, WorkItem } from "../types.js";

/** Item types the Implementer is allowed to execute directly. */
const EXECUTABLE_TYPES: ReadonlySet<ItemType> = new Set<ItemType>([
  "bug",
  "task",
  "chore-dx",
]);

/**
 * True only when the item is in the configured `ready` state, is of an
 * executable type, and is not blocked by an unapproved parent PRD
 * (parentApproved === false). A null or true parentApproved is OK.
 */
export function isExecutable(item: WorkItem, cfg: CrewConfig): boolean {
  if (item.stateName !== cfg.tracker.statuses.ready) return false;
  if (item.type === null || !EXECUTABLE_TYPES.has(item.type)) return false;
  if (item.parentApproved === false) return false;
  return true;
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
