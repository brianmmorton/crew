import type { AgentDef, CrewConfig } from "../types.js";
import type { AgentRow, Snapshot } from "./snapshot.js";
import type { StuckItem } from "../engine/stuck.js";
import { store, resetStore } from "./store.js";

/**
 * Fixture states for the TUI, in the spirit of a Storybook: each story puts
 * the store into one specific shape so a screen can be looked at (`crew tui
 * --story <name>`) or asserted against (tui.test.tsx) without a tracker, a
 * repo, or a live agent.
 *
 * These deliberately cover the states that are awkward to reach for real —
 * an error frame, a reviewer that also has a cadence, a stuck-item list, a
 * run streaming output — because those are where the rendering bugs live.
 */

const cfg = {
  project: "scoutsense",
  configDir: "/tmp/.crew",
  repo: { path: "/Users/x/Sites/scoutsense", baseBranch: "main" },
  triager: { backlogCap: 30 },
  gates: { wipCap: 3 },
  budget: { implementerWorkers: 1 },
  worktrees: { reuse: false, max: 2 },
  ui: {},
} as unknown as CrewConfig;

const agent = (name: string, kind: string, cadence = ""): AgentDef =>
  ({ name, kind, cadence, prompt: "" }) as unknown as AgentDef;

// 04:00 PM in every timezone the tests might run in would need a fixed
// instant; these rows use a fixed epoch so snapshot-style assertions on the
// schedule column stay stable.
const at = (iso: string) => new Date(iso);

const rows: AgentRow[] = [
  { agent: agent("architect", "proposer", "0 9 * * *"), next: at("2026-01-01T09:00:00Z") },
  { agent: agent("design", "proposer", "0 9 * * *"), next: at("2026-01-01T09:00:00Z") },
  { agent: agent("qa", "proposer", "0 18 * * *"), next: at("2026-01-01T18:00:00Z") },
  { agent: agent("implementer", "executor"), next: null },
];

/**
 * A reviewer that also carries a cadence. `scheduledAgents()` is "not an
 * executor and has a cadence", so this agent matches both that pass and the
 * reviewer pass in takeSnapshot — it used to render twice, with duplicate
 * React keys and a selection cursor on each copy.
 */
const rowsWithScheduledReviewer: AgentRow[] = [
  ...rows.slice(0, 3),
  { agent: agent("critic", "reviewer", "0 12 * * *"), next: at("2026-01-01T12:00:00Z") },
  rows[3],
];

const stuck: StuckItem[] = [
  {
    identifier: "SCO-142",
    state: "working",
    claim: null,
    verifyTries: 0,
    landTries: 0,
    reason: null,
  },
  {
    identifier: "SCO-138",
    state: "fixing",
    claim: null,
    verifyTries: 2,
    landTries: 0,
    reason: "typecheck failed in apps/web",
  },
  {
    identifier: "SCO-131",
    state: "abandoned",
    claim: null,
    verifyTries: 3,
    landTries: 1,
    reason: "worker process gone",
  },
];

const logLines = [
  "2026-07-28T22:59:31.065Z INFO  crew executor loop started {\"project\":\"scoutsense\"}",
  "2026-07-28T22:59:31.626Z INFO  executor idle: no ready work in \"Todo\"",
  "2026-07-28T23:01:02.114Z WARN  implementerWorkers=2 with worktrees.reuse off",
  "2026-07-28T23:02:44.900Z ERROR executor loop tick failed; continuing",
  "a line that does not match the log format at all",
];

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cfg,
    backlog: 22,
    inProgress: 2,
    slots: null,
    agentRows: rows,
    stuck: [],
    supervisorAlive: false,
    logPath: "/dev/null",
    mcpOAuth: [],
    error: null,
    ...over,
  } as Snapshot;
}

export interface Story {
  name: string;
  description: string;
  setup: () => void;
}

export const stories: Story[] = [
  {
    name: "loading",
    description: "First paint, before the first snapshot lands",
    setup: () => {
      store.rows = 30;
    },
  },
  {
    name: "dashboard",
    description: "Steady state: agents, log, no stuck work",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.logLines = logLines;
    },
  },
  {
    name: "scheduled-reviewer",
    description: "Reviewer with a cadence — must appear exactly once",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot({ agentRows: rowsWithScheduledReviewer });
      store.logLines = logLines;
    },
  },
  {
    name: "in-flight",
    description: "Stuck items panel, including an abandoned claim",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot({ stuck });
      store.logLines = logLines;
    },
  },
  {
    name: "paused",
    description: "Implementer paused — executor row shows a pause, not a spinner",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.implPaused = true;
    },
  },
  {
    name: "selection-last",
    description: "Cursor on the final row, the executor",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.selected = rows.length - 1;
    },
  },
  {
    name: "selection-overflow",
    description: "selected past the end of a shrunken list — must still show one cursor",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.selected = 99;
    },
  },
  {
    name: "error",
    description: "Snapshot failed (bad credentials, rate limit)",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot({
        error: "Rate limit exceeded. Only 3000000 complexity points are allowed per 1 hour.",
      });
    },
  },
  {
    name: "mcp-oauth",
    description: "Header shows MCP servers, one logged out",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot({
        mcpOAuth: [
          { server: "linear", loggedIn: true },
          { server: "sentry", loggedIn: false },
        ],
      });
    },
  },
  {
    name: "pool",
    description: "Header shows worktree pool counts",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot({
        slots: [
          { slot: 0, state: "busy" },
          { slot: 1, state: "free" },
          { slot: 2, state: "retained" },
        ] as Snapshot["slots"],
      });
    },
  },
  {
    name: "run-view",
    description: "Expanded view of a live agent run",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.runs.set("design", {
        agent: "design",
        status: "running",
        startedAt: at("2026-01-01T00:00:00Z"),
        endedAt: null,
        lines: ["design · reading AGENTS.md", "design → Bash ls apps/web/src/routes/"],
        exitCode: null,
      });
      store.expanded = "design";
    },
  },
  {
    name: "run-view-failed",
    description: "Expanded view after a run failed",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.runs.set("design", {
        agent: "design",
        status: "failed",
        startedAt: at("2026-01-01T00:00:00Z"),
        endedAt: at("2026-01-01T00:01:12Z"),
        lines: ["design · starting", "[tui] failed to start: ENOENT"],
        exitCode: 1,
      });
      store.expanded = "design";
    },
  },
  {
    name: "run-badge",
    description: "Agent list shows done/failed badges for finished runs",
    setup: () => {
      store.rows = 30;
      store.snap = snapshot();
      store.runs.set("design", {
        agent: "design",
        status: "exited",
        startedAt: at("2026-01-01T00:00:00Z"),
        endedAt: at("2026-01-01T00:00:30Z"),
        lines: [],
        exitCode: 0,
      });
      store.runs.set("qa", {
        agent: "qa",
        status: "failed",
        startedAt: at("2026-01-01T00:00:00Z"),
        endedAt: at("2026-01-01T00:00:30Z"),
        lines: [],
        exitCode: 2,
      });
    },
  },
  {
    name: "narrow",
    description: "Short terminal — log panel must clamp, not overflow",
    setup: () => {
      store.rows = 12;
      store.snap = snapshot({ stuck });
      store.logLines = logLines;
    },
  },
];

export function getStory(name: string): Story | undefined {
  return stories.find((s) => s.name === name);
}

/** Reset the store, then apply one story's fixture. */
export function applyStory(story: Story): void {
  resetStore();
  story.setup();
}
