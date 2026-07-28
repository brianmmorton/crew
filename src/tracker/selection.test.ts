import { test } from "node:test";
import assert from "node:assert/strict";
import type { CrewConfig, ItemType, WorkItem } from "../types.js";
import { explainEmpty, isExecutable, labelGateActive, rankCandidates } from "./selection.js";

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

// ------------------------- the needs-human guarantee ------------------------

/**
 * `needs-human` is enforced separately from `excludeLabels` on purpose: a user
 * who configures that list would otherwise overwrite the default and silently
 * put the executor back on work that asked for a person.
 */

/** cfg carrying the lifecycle label names, as a loaded config always does. */
const labelled = {
  ...cfg,
  tracker: {
    ...cfg.tracker,
    labels: { stuck: "crew:stuck", needsHuman: "crew:needs-human" },
  },
} as unknown as CrewConfig;

test("an item marked needs-human is never executable", () => {
  assert.equal(isExecutable(item({ labels: ["crew:needs-human"] }), labelled), false);
});

test("needs-human holds even when the item also satisfies requireLabels", () => {
  const g = {
    ...labelled,
    tracker: {
      ...(labelled.tracker as object),
      executable: { requireLabels: ["crew"], excludeLabels: [] },
    },
  } as unknown as CrewConfig;
  assert.equal(isExecutable(item({ labels: ["crew"] }), g), true);
  assert.equal(isExecutable(item({ labels: ["crew", "crew:needs-human"] }), g), false);
});

test("a user-configured excludeLabels does not displace the needs-human guard", () => {
  const g = {
    ...labelled,
    tracker: {
      ...(labelled.tracker as object),
      executable: { requireLabels: [], excludeLabels: ["blocked"] },
    },
  } as unknown as CrewConfig;
  assert.equal(isExecutable(item({ labels: ["blocked"] }), g), false);
  assert.equal(isExecutable(item({ labels: ["crew:needs-human"] }), g), false);
});

test("the stuck label does NOT block execution — it is how work resumes", () => {
  assert.equal(isExecutable(item({ labels: ["crew:stuck"] }), labelled), true);
});

test("a config without lifecycle label names still selects normally", () => {
  // `cfg` has no tracker.labels at all, as a pre-upgrade config would not.
  assert.equal(isExecutable(item({ labels: ["crew:needs-human"] }), cfg), true);
});

/** cfg with a label gate layered over the shared base. */
function gated(gate: { requireLabels?: string[]; excludeLabels?: string[] }): CrewConfig {
  return {
    ...cfg,
    tracker: {
      ...cfg.tracker,
      executable: { requireLabels: [], excludeLabels: [], ...gate },
    },
  } as unknown as CrewConfig;
}

test("label gate is inert when both lists are empty", () => {
  const empty = gated({});
  assert.equal(isExecutable(item({ labels: [] }), empty), true);
  assert.equal(isExecutable(item({ labels: ["anything"] }), empty), true);
  // and when tracker.executable is absent entirely (configs written before it)
  assert.equal(isExecutable(item({ labels: [] }), cfg), true);
});

test("requireLabels admits only items carrying one of them", () => {
  const g = gated({ requireLabels: ["crew", "agent-ok"] });
  assert.equal(isExecutable(item({ labels: ["crew"] }), g), true);
  assert.equal(isExecutable(item({ labels: ["agent-ok"] }), g), true);
  assert.equal(isExecutable(item({ labels: ["crew", "other"] }), g), true);
  assert.equal(isExecutable(item({ labels: ["other"] }), g), false);
  assert.equal(isExecutable(item({ labels: [] }), g), false);
});

test("excludeLabels blocks matching items but keeps unlabeled work", () => {
  const g = gated({ excludeLabels: ["blocked", "needs-human"] });
  assert.equal(isExecutable(item({ labels: ["blocked"] }), g), false);
  assert.equal(isExecutable(item({ labels: ["needs-human"] }), g), false);
  assert.equal(isExecutable(item({ labels: ["crew"] }), g), true);
  assert.equal(isExecutable(item({ labels: [] }), g), true);
});

test("excludeLabels wins over requireLabels", () => {
  const g = gated({ requireLabels: ["crew"], excludeLabels: ["blocked"] });
  assert.equal(isExecutable(item({ labels: ["crew"] }), g), true);
  assert.equal(isExecutable(item({ labels: ["crew", "blocked"] }), g), false);
});

test("label gate composes with the other executability rules", () => {
  const g = gated({ requireLabels: ["crew"] });
  // right label, but wrong state / type / blocked parent still reject
  assert.equal(isExecutable(item({ labels: ["crew"], stateName: "Backlog" }), g), false);
  assert.equal(isExecutable(item({ labels: ["crew"], type: "prd" }), g), false);
  assert.equal(isExecutable(item({ labels: ["crew"], parentApproved: false }), g), false);
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

// ------------------------- empty-selection diagnostics ---------------------

test("labelGateActive is false only when both lists are empty", () => {
  assert.equal(labelGateActive(cfg), false); // no executable block at all
  assert.equal(labelGateActive(gated({})), false);
  assert.equal(labelGateActive(gated({ requireLabels: ["crew"] })), true);
  assert.equal(labelGateActive(gated({ excludeLabels: ["blocked"] })), true);
});

test("explainEmpty attributes a gate-emptied queue", () => {
  const g = gated({ requireLabels: ["crew"] });
  const r = explainEmpty([item({ labels: ["other"] }), item({ labels: [] })], g);
  assert.equal(r.ready, 2);
  assert.equal(r.passedGate, 0); // the signal the loop warns on
  assert.deepEqual(r.requireLabels, ["crew"]);
});

test("explainEmpty distinguishes a genuinely empty queue", () => {
  const r = explainEmpty([], gated({ requireLabels: ["crew"] }));
  assert.equal(r.ready, 0);
  assert.equal(r.passedGate, 0);
});

test("explainEmpty reports partial coverage when some items pass", () => {
  const g = gated({ requireLabels: ["crew"] });
  const r = explainEmpty([item({ labels: ["crew"] }), item({ labels: ["other"] })], g);
  assert.equal(r.ready, 2);
  assert.equal(r.passedGate, 1);
});
