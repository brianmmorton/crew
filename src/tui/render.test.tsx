import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { Header } from "./Header.js";
import { AgentList } from "./AgentList.js";
import { LogPanel } from "./LogPanel.js";
import { getStory, applyStory } from "./stories.js";
import { store, appendLogLines, publishSnapshot } from "./store.js";
import type { Snapshot } from "./snapshot.js";

/**
 * Render-cost tests. The TUI's flicker came from work being done per frame
 * that didn't need doing: a log line re-rendering the whole dashboard, and a
 * poll tick re-rendering it once a second whether or not anything moved.
 * These pin the cost down so a future change can't quietly reintroduce it.
 */

interface Counts {
  Screen: number;
  Header: number;
  AgentList: number;
  LogPanel: number;
}

/**
 * Mounts the dashboard with each section wrapped in a memo that counts its
 * renders, mirroring how Screen composes them in App.tsx.
 */
function mount() {
  const counts: Counts = { Screen: 0, Header: 0, AgentList: 0, LogPanel: 0 };

  const H = React.memo(function H() {
    counts.Header++;
    return <Header />;
  });
  const A = React.memo(function A(p: { implWorkers: number; maxRows: number }) {
    counts.AgentList++;
    return <AgentList {...p} />;
  });
  const L = React.memo(function L(p: { height: number }) {
    counts.LogPanel++;
    return <LogPanel {...p} />;
  });

  function Probe() {
    counts.Screen++;
    const snap = useSnapshot(store);
    if (!snap.snap) return <Text>loading</Text>;
    return (
      <Box flexDirection="column">
        <H />
        <A implWorkers={1} maxRows={4} />
        <L height={6} />
      </Box>
    );
  }

  const r = render(<Probe />);
  return { counts, ...r };
}

/** Runs a mutation and reports how many renders it caused, per section. */
async function renders(counts: Counts, fn: () => void): Promise<Counts> {
  counts.Screen = counts.Header = counts.AgentList = counts.LogPanel = 0;
  fn();
  // valtio batches mutations into a microtask; let it flush.
  await new Promise((r) => setTimeout(r, 50));
  return { ...counts };
}

test("a new log line does not re-render the rest of the dashboard", async () => {
  applyStory(getStory("dashboard")!);
  const { counts, lastFrame, unmount } = mount();

  const after = await renders(counts, () => appendLogLines(["x INFO  hello"]));
  unmount();

  assert.equal(after.Header, 0, "Header re-rendered for a log line");
  assert.equal(after.AgentList, 0, "AgentList re-rendered for a log line");
  assert.equal(after.Screen, 0, "Screen re-rendered for a log line");
  // And the line still made it to the screen.
  assert.match((lastFrame() ?? "").replace(/\[[0-9;]*m/g, ""), /hello/);
});

test("a poll tick with no visible change re-renders nothing", async () => {
  // The poller rebuilds a whole Snapshot every second. Publishing it
  // unconditionally handed valtio a new object reference each time and
  // re-rendered the dashboard once a second on a completely idle project.
  applyStory(getStory("dashboard")!);
  const { counts, unmount } = mount();

  const after = await renders(counts, () => {
    publishSnapshot({ ...store.snap! } as Snapshot);
  });
  unmount();

  assert.deepEqual(after, { Screen: 0, Header: 0, AgentList: 0, LogPanel: 0 });
});

test("publishSnapshot reports whether it actually wrote", () => {
  applyStory(getStory("dashboard")!);
  const same = publishSnapshot({ ...store.snap! } as Snapshot);
  assert.equal(same, false, "an unchanged snapshot should be dropped");

  const changed = publishSnapshot({
    ...store.snap!,
    backlog: store.snap!.backlog + 1,
  } as Snapshot);
  assert.equal(changed, true, "a changed snapshot should be published");
});

test("a poll tick that does change something re-renders once", async () => {
  applyStory(getStory("dashboard")!);
  const { counts, unmount } = mount();

  const after = await renders(counts, () => {
    publishSnapshot({ ...store.snap!, backlog: store.snap!.backlog + 1 } as Snapshot);
  });
  unmount();

  assert.equal(after.Screen, 1, "expected exactly one Screen render");
  // The count lives in the header, so the other sections stay put.
  assert.equal(after.AgentList, 0);
  assert.equal(after.LogPanel, 0);
});

test("changes the header does not show do not re-render it", async () => {
  // logPath and cfg are part of the Snapshot but nothing renders them, so a
  // tick that only moves those must not cost a frame.
  applyStory(getStory("dashboard")!);
  const { counts, unmount } = mount();

  const after = await renders(counts, () => {
    publishSnapshot({ ...store.snap!, logPath: "/somewhere/else.log" } as Snapshot);
  });
  unmount();

  assert.deepEqual(after, { Screen: 0, Header: 0, AgentList: 0, LogPanel: 0 });
});

test("appending many log lines costs one render each, not one per visible row", async () => {
  applyStory(getStory("dashboard")!);
  const { counts, unmount } = mount();

  const after = await renders(counts, () => {
    for (let i = 0; i < 20; i++) appendLogLines([`t INFO  line ${i}`]);
  });
  unmount();

  // valtio coalesces the burst, and the rest of the dashboard is untouched
  // regardless of how many lines arrived.
  assert.equal(after.Header, 0);
  assert.equal(after.AgentList, 0);
  assert.equal(after.Screen, 0);
});
