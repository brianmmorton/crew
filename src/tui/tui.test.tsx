import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Screen } from "./App.js";
import { stories, getStory, applyStory } from "./stories.js";
import { store } from "./store.js";

/**
 * Renders one story through the real Screen tree and returns the frame with
 * ANSI escapes stripped, so assertions can be written against what a person
 * would actually see on the terminal.
 */
function frameFor(name: string): string {
  const story = getStory(name);
  assert.ok(story, `no story named ${name}`);
  applyStory(story);
  const { lastFrame, unmount } = render(<Screen implWorkers={1} />);
  const out = lastFrame() ?? "";
  unmount();
  // eslint-disable-next-line no-control-regex
  return out.replace(/\[[0-9;]*m/g, "");
}

test("every story renders without throwing and produces output", () => {
  for (const story of stories) {
    const frame = frameFor(story.name);
    assert.ok(frame.length > 0, `story "${story.name}" rendered nothing`);
  }
});

test("the loading story shows the splash and no dashboard chrome", () => {
  const frame = frameFor("loading");
  assert.match(frame, /reading agents, tracker, and worktree pool/);
  assert.doesNotMatch(frame, /AGENTS/);
});

/**
 * Just the AGENTS block. Agent names also occur in log lines and the footer
 * hint ("pause/resume implementer"), so counting rows across the whole frame
 * would match those too.
 */
function agentBlock(frame: string): string[] {
  const lines = frame.split("\n");
  const start = lines.findIndex((l) => l.trim() === "AGENTS");
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() === "");
  return end === -1 ? rest : rest.slice(0, end);
}

test("the dashboard lists every agent exactly once", () => {
  const block = agentBlock(frameFor("dashboard"));
  for (const name of ["architect", "design", "qa", "implementer"]) {
    const hits = block.filter((l) => l.includes(name)).length;
    assert.equal(hits, 1, `expected one row for ${name}, saw ${hits}`);
  }
});

test("a reviewer that also has a cadence is listed once, not twice", () => {
  // scheduledAgents() is "not an executor and has a cadence", so a scheduled
  // reviewer matches both that pass and the reviewer pass in takeSnapshot.
  // It used to render twice, with duplicate keys and two selection cursors.
  const block = agentBlock(frameFor("scheduled-reviewer"));
  const hits = block.filter((l) => l.includes("critic")).length;
  assert.equal(hits, 1, `expected one row for critic, saw ${hits}`);
});

test("exactly one selection cursor is drawn", () => {
  for (const name of ["dashboard", "scheduled-reviewer", "selection-last", "in-flight"]) {
    const cursors = (frameFor(name).match(/❯/g) ?? []).length;
    assert.equal(cursors, 1, `story "${name}" drew ${cursors} cursors`);
  }
});

test("a selection index past the end of the list still draws one cursor", () => {
  // The row list can shrink between polls; a stale index must clamp rather
  // than leave the list with no cursor at all.
  const cursors = (frameFor("selection-overflow").match(/❯/g) ?? []).length;
  assert.equal(cursors, 1);
});

test("the executor row shows paused instead of a spinner when paused", () => {
  const frame = frameFor("paused");
  assert.match(frame, /paused/);
  assert.doesNotMatch(frame, /running \(1w\)/);
});

test("a snapshot error renders the error frame and nothing else", () => {
  const frame = frameFor("error");
  assert.match(frame, /Rate limit exceeded/);
  assert.doesNotMatch(frame, /AGENTS/);
  assert.doesNotMatch(frame, /LOG/);
});

test("stuck items render with their state and reason", () => {
  const frame = frameFor("in-flight");
  assert.match(frame, /IN FLIGHT \(3\)/);
  assert.match(frame, /1 abandoned/);
  assert.match(frame, /SCO-138/);
  assert.match(frame, /typecheck failed/);
});

test("the log panel renders parsed and unparsed lines", () => {
  const frame = frameFor("dashboard");
  assert.match(frame, /LOG/);
  assert.match(frame, /crew executor loop started/);
  // A line that doesn't match the timestamp/level format still shows up.
  assert.match(frame, /a line that does not match the log format/);
});

test("mcp oauth rows show login state and the fix hint", () => {
  const frame = frameFor("mcp-oauth");
  assert.match(frame, /linear/);
  assert.match(frame, /sentry/);
  assert.match(frame, /crew mcp login/);
});

test("worktree pool counts render in the header", () => {
  const frame = frameFor("pool");
  assert.match(frame, /1 free/);
  assert.match(frame, /1 busy/);
  assert.match(frame, /1 retained/);
});

test("an expanded run shows its output and the run-view footer", () => {
  const frame = frameFor("run-view");
  assert.match(frame, /design/);
  assert.match(frame, /reading AGENTS\.md/);
  assert.match(frame, /back to dashboard/);
  // The dashboard chrome must be replaced, not drawn underneath.
  assert.doesNotMatch(frame, /AGENTS\n/);
});

test("a failed run shows its exit code", () => {
  const frame = frameFor("run-view-failed");
  assert.match(frame, /failed/);
  assert.match(frame, /exit 1/);
});

test("finished runs show done and failed badges in the agent list", () => {
  const frame = frameFor("run-badge");
  assert.match(frame, /done/);
  assert.match(frame, /failed/);
});

test("expanded pointing at a run that does not exist falls back to the dashboard", () => {
  // Clearing store.expanded during render would re-enter the renderer and
  // tear the frame, so a stale name has to fall through instead.
  applyStory(getStory("dashboard")!);
  store.expanded = "nonexistent";
  const { lastFrame, unmount } = render(<Screen implWorkers={1} />);
  const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  unmount();
  assert.match(frame, /AGENTS/);
  assert.doesNotMatch(frame, /back to dashboard/);
});

test("the frame never grows taller than the terminal", () => {
  // A frame taller than the window scrolls its own top away, which on screen
  // reads as the UI repeating itself. Checked across the awkward range where
  // the log panel has to shrink and then drop out entirely.
  for (const rows of [8, 10, 12, 14, 16, 20, 24, 30, 40]) {
    for (const storyName of ["dashboard", "in-flight", "mcp-oauth"]) {
      applyStory(getStory(storyName)!);
      store.rows = rows;
      const { lastFrame, unmount } = render(<Screen implWorkers={1} />);
      const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
      unmount();
      const used = frame.split("\n").length;
      assert.ok(
        used <= rows,
        `story "${storyName}" at rows=${rows} rendered ${used} lines`,
      );
    }
  }
});

test("a tall terminal gives the log panel the extra room", () => {
  applyStory(getStory("dashboard")!);
  store.rows = 40;
  const { lastFrame, unmount } = render(<Screen implWorkers={1} />);
  const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  unmount();
  assert.match(frame, /LOG/);
  assert.match(frame, /crew executor loop started/);
});

test("a short terminal drops the log panel rather than overflowing", () => {
  const frame = frameFor("narrow");
  assert.ok(frame.split("\n").length <= 12, "narrow frame overflowed");
  // The log is the first thing to yield when there is no room for it.
  assert.doesNotMatch(frame, /^LOG$/m);
  assert.match(frame, /AGENTS/);
});

test("in-flight work keeps its space ahead of the agent list", () => {
  // In-flight is what says something is wrong right now; the agent list is
  // near-static, so it's the one that truncates on a short window.
  const frame = frameFor("narrow");
  assert.match(frame, /IN FLIGHT \(3\)/);
  for (const id of ["SCO-142", "SCO-138", "SCO-131"]) {
    assert.match(frame, new RegExp(id));
  }
});

test("a truncated agent list says how many rows are hidden", () => {
  const frame = frameFor("narrow");
  assert.match(frame, /AGENTS\s+\(\d+ of 4\)/);
});

test("a truncated in-flight list says how many items are hidden", () => {
  applyStory(getStory("in-flight")!);
  store.rows = 11; // room for the header, a couple of items, and the footer
  const { lastFrame, unmount } = render(<Screen implWorkers={1} />);
  const frame = (lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
  unmount();
  assert.ok(frame.split("\n").length <= 11, "frame overflowed");
  // Either everything fit, or the ones that didn't are accounted for.
  if (!frame.includes("SCO-131")) assert.match(frame, /\+\d+ more/);
});
