import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { CrewConfig } from "../types.js";
import { takeSnapshot, LogTail, type Snapshot } from "./snapshot.js";
import { RunManager, type AgentRun } from "./runManager.js";
import { Header } from "./Header.js";
import { AgentList } from "./AgentList.js";
import { LogPanel } from "./LogPanel.js";
import { InFlight } from "./InFlight.js";
import { RunView } from "./RunView.js";
import { LoadingSplash } from "./Spinner.js";

const POLL_MS = 1000;
const MAX_LOG_LINES = 500;

export function App({ cfg }: { cfg: CrewConfig }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [rows, setRows] = useState(stdout?.rows ?? 24);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  const runManager = useMemo(() => new RunManager(), []);
  const runsRef = useRef<Map<string, AgentRun>>(new Map());

  useEffect(() => {
    return runManager.onChange(() => forceRender((n) => n + 1));
  }, [runManager]);

  useEffect(() => {
    return () => runManager.stopAll();
  }, [runManager]);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const next = await takeSnapshot(cfg);
      if (cancelled) return;
      setSnap(next);
      const appended = new LogTail(next.logPath).read();
      if (appended.length) {
        setLogLines((prev) => [...prev, ...appended].slice(-MAX_LOG_LINES));
      }
    }

    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cfg]);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const agentRows = snap?.agentRows ?? [];
  // Rebuilt each render from the manager rather than cached in state — the
  // manager is the source of truth and this keeps a run's line buffer from
  // needing its own state channel back up to App.
  for (const row of agentRows) {
    const run = runManager.get(row.agent.name);
    if (run) runsRef.current.set(row.agent.name, run);
  }

  useInput((input, key) => {
    if (expanded) {
      if (key.escape) setExpanded(null);
      else if (input === "k") runManager.stop(expanded);
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSelected((s) => Math.min(agentRows.length - 1, s + 1));
    else if (key.return || input === " ") {
      const row = agentRows[selected];
      if (!row || row.agent.kind === "reviewer") return;
      runManager.start(row.agent.name);
      setExpanded(row.agent.name);
    }
  });

  if (expanded) {
    const run = runManager.get(expanded);
    if (run) {
      return <RunView run={run} height={Math.max(4, rows - 6)} />;
    }
    setExpanded(null);
  }

  if (!snap) {
    return (
      <Box marginTop={1}>
        <LoadingSplash label="reading agents, tracker, and worktree pool…" />
      </Box>
    );
  }

  if (snap.error) {
    return (
      <Box flexDirection="column">
        <Text color="red">crew tui: {snap.error}</Text>
      </Box>
    );
  }

  // Header ~4 lines, AGENTS block ~(rows+2), IN FLIGHT block variable, footer 1.
  // The log panel takes whatever is left, so it's the one section that grows
  // or shrinks with the terminal instead of the terminal scrolling past it.
  const reserved = 4 + agentRows.length + 2 + (snap.stuck.length ? snap.stuck.length + 2 : 0) + 2;
  const logHeight = Math.max(4, rows - reserved);

  return (
    <Box flexDirection="column">
      <Header snap={snap} />
      <AgentList rows={agentRows} runs={runsRef.current} selected={selected} />
      <Box marginTop={1}>
        <LogPanel lines={logLines} height={logHeight} />
      </Box>
      <InFlight items={snap.stuck} />
      <Box marginTop={1}>
        <Text dimColor>[↑↓] select  [enter] run / view  [q] quit</Text>
      </Box>
    </Box>
  );
}
