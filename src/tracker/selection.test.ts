import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrewConfig, ItemType, WorkItem } from "../types.js";
import { isExecutable, rankCandidates } from "./selection.js";

const cfg = {
  tracker: {
    statuses: {
      backlog: "Backlog",
      ready: "Todo",
      inProgress: "In Progress",
      review: "In Review",
      needsApproval: "Needs Approval",
      done: "Done",
    },
  },
} as unknown as CrewConfig;

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: overrides.id ?? "id-1",
    identifier: overrides.identifier ?? "BRI-1",
    title: overrides.title ?? "Some work",
    description: overrides.description ?? "",
    type: "type" in overrides ? (overrides.type as ItemType | null) : "task",
    stateName: overrides.stateName ?? "Todo",
    priority: overrides.priority ?? 3,
    parentId: overrides.parentId ?? null,
    parentApproved: overrides.parentApproved ?? null,
    url: overrides.url ?? "https://linear.app/x",
    assigneeId: overrides.assigneeId ?? null,
    labels: overrides.labels ?? [],
  };
}

test("isExecutable accepts ready, executable-type, non-blocked items", () => {
  assert.equal(isExecutable(item({ type: "bug" }), cfg), true);
  assert.equal(isExecutable(item({ type: "task" }), cfg), true);
  assert.equal(isExecutable(item({ type: "chore-dx" }), cfg), true);
  // parentApproved null (ungated) and true both OK
  assert.equal(isExecutable(item({ parentApproved: null }), cfg), true);
  assert.equal(isExecutable(item({ parentApproved: true }), cfg), true);
});

test("isExecutable rejects non-ready state", () => {
  assert.equal(isExecutable(item({ stateName: "Backlog" }), cfg), false);
  assert.equal(isExecutable(item({ stateName: "In Progress" }), cfg), false);
});

test("isExecutable rejects wrong types", () => {
  assert.equal(isExecutable(item({ type: "prd" }), cfg), false);
  assert.equal(isExecutable(item({ type: "spike" }), cfg), false);
  assert.equal(isExecutable(item({ type: null }), cfg), false);
});

test("isExecutable rejects items whose parent is not approved", () => {
  assert.equal(isExecutable(item({ parentApproved: false }), cfg), false);
});

test("rankCandidates orders urgent > high > normal > low > none", () => {
  const none = item({ identifier: "BRI-5", priority: 0 });
  const urgent = item({ identifier: "BRI-1", priority: 1 });
  const high = item({ identifier: "BRI-2", priority: 2 });
  const normal = item({ identifier: "BRI-3", priority: 3 });
  const low = item({ identifier: "BRI-4", priority: 4 });

  const ranked = rankCandidates([none, low, normal, high, urgent]);
  assert.deepEqual(
    ranked.map((i) => i.priority),
    [1, 2, 3, 4, 0],
  );
});

test("rankCandidates tie-breaks by identifier ascending", () => {
  const a = item({ identifier: "BRI-10", priority: 2 });
  const b = item({ identifier: "BRI-2", priority: 2 });
  const c = item({ identifier: "BRI-1", priority: 2 });

  const ranked = rankCandidates([a, b, c]);
  assert.deepEqual(
    ranked.map((i) => i.identifier),
    ["BRI-1", "BRI-10", "BRI-2"],
  );
});

test("rankCandidates does not mutate its input", () => {
  const input = [
    item({ identifier: "BRI-2", priority: 0 }),
    item({ identifier: "BRI-1", priority: 1 }),
  ];
  const snapshot = input.map((i) => i.identifier);
  rankCandidates(input);
  assert.deepEqual(
    input.map((i) => i.identifier),
    snapshot,
  );
});

// Reference the ItemType import so it is not flagged as unused under strict TS.
const _executableTypes: ItemType[] = ["bug", "task", "chore-dx"];
void _executableTypes;
