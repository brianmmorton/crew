import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import type { AgentKind } from "../types.js";
import { agentsStore } from "./stores/agents.js";
import { runOutputStore, runsStore } from "./stores/runs.js";
import { poolStore } from "./stores/pool.js";
import { clockStore } from "./stores/clock.js";
import { fmtElapsed, fmtUntil, windowStart } from "./layout.js";
import { agentColor } from "./palette.js";
import { Spinner } from "./Spinner.js";

/**
 * The accordion. The panel maps the visible window and hands each block only
 * primitive props, so a selection move re-renders exactly two memoized
 * blocks (the row it left and the row it landed on), and streaming output
 * re-renders only the expanded pane of the agent producing it.
 */

interface BlockProps {
  name: string;
  kind: AgentKind;
  cadence: string;
  nextRun: number | null;
  index: number;
  isSelected: boolean;
  isExpanded: boolean;
  paneH: number;
}

export const AgentsPanel = memo(function AgentsPanel({
  listRows,
  paneH,
}: {
  listRows: number;
  paneH: number;
}): React.ReactNode {
  const snap = useSnapshot(agentsStore);
  const start = windowStart(snap.items.length, listRows, snap.selected);
  const visible = snap.items.slice(start, start + listRows);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {visible.length === 0 && (
        <Text dimColor wrap="truncate-end">
          {"   no agents found — add personas/<name>.md and restart"}
        </Text>
      )}
      {visible.map((a, i) => (
        <AgentBlock
          key={a.name}
          name={a.name}
          kind={a.kind}
          cadence={a.cadence}
          nextRun={a.nextRun}
          index={start + i}
          isSelected={start + i === snap.selected}
          isExpanded={Boolean(snap.expanded[a.name])}
          paneH={paneH}
        />
      ))}
    </Box>
  );
});

const AgentBlock = memo(function AgentBlock(props: BlockProps): React.ReactNode {
  return (
    <>
      <AgentRow {...props} />
      {props.isExpanded && props.paneH > 0 && (
        <AgentPane name={props.name} kind={props.kind} paneH={props.paneH} />
      )}
    </>
  );
});

function AgentRow({ name, kind, cadence, nextRun, index, isSelected, isExpanded }: BlockProps) {
  const color = agentColor(name);
  return (
    <Text wrap="truncate-end">
      <Text color="cyanBright">{isSelected ? " ❯ " : "   "}</Text>
      <Text dimColor>{index < 9 ? `${index + 1} ` : "  "}</Text>
      <Text dimColor>{isExpanded ? "▾ " : "▸ "}</Text>
      <Text color={color} bold={isSelected}>
        {name.padEnd(14)}
      </Text>
      <Text dimColor>{kind.padEnd(10)}</Text>
      <ScheduleCell kind={kind} cadence={cadence} nextRun={nextRun} />
      <StatusCell name={name} kind={kind} />
    </Text>
  );
}

function ScheduleCell({
  kind,
  cadence,
  nextRun,
}: {
  kind: AgentKind;
  cadence: string;
  nextRun: number | null;
}) {
  // `.now` is read only when a countdown is on screen, so idle rows don't
  // subscribe to the 1s clock at all.
  const clock = useSnapshot(clockStore);
  const cell =
    kind === "executor"
      ? "continuous"
      : kind === "reviewer"
        ? "on PR"
        : nextRun
          ? fmtUntil(nextRun, clock.now)
          : cadence || "manual";
  return <Text dimColor>{cell.padEnd(10)}</Text>;
}

/** The live status cell: run state for proposers, pool state for executors. */
function StatusCell({ name, kind }: { name: string; kind: AgentKind }) {
  const pool = useSnapshot(poolStore);
  const run = useSnapshot(runsStore).byAgent[name];
  const clock = useSnapshot(clockStore);

  if (kind === "executor") {
    return pool.executorPaused ? (
      <Text color="yellow" bold>
        ⏸ paused
      </Text>
    ) : (
      <Text color="green">▶ active</Text>
    );
  }

  switch (run?.status) {
    case "running":
      return (
        <>
          <Spinner color={agentColor(name)} />
          <Text color={agentColor(name)}> running {fmtElapsed(run.startedAt, clock.now)}</Text>
        </>
      );
    case "paused":
      return (
        <Text color="yellow" bold>
          ⏸ paused {fmtElapsed(run.startedAt, clock.now)}
        </Text>
      );
    case "done":
      return <Text color="green">✔ done {fmtElapsed(run.startedAt, run.endedAt ?? run.startedAt)}</Text>;
    case "failed":
      return (
        <Text color="red">✘ failed{run.exitCode !== null ? ` (exit ${run.exitCode})` : ""}</Text>
      );
    default:
      return <Text dimColor>idle</Text>;
  }
}

/**
 * The expanded pane under a row: exactly `paneH` lines, always — short
 * content is padded so the frame height never depends on how much an agent
 * has said (the incremental-rendering invariant, see layout.ts).
 */
const AgentPane = memo(function AgentPane({
  name,
  kind,
  paneH,
}: {
  name: string;
  kind: AgentKind;
  paneH: number;
}): React.ReactNode {
  const lines = kind === "executor" ? <ExecutorPane paneH={paneH} /> : <RunPane name={name} paneH={paneH} />;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines}
    </Box>
  );
});

function padLines(lines: string[], height: number): string[] {
  const shown = lines.slice(-height);
  while (shown.length < height) shown.push("");
  return shown;
}

function RunPane({ name, paneH }: { name: string; paneH: number }) {
  const output = useSnapshot(runOutputStore).byAgent[name];
  const color = agentColor(name);
  const lines = padLines(
    output && output.length ? [...output] : ["(no output yet — press r to run)"],
    paneH,
  );
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={color} dimColor>
            {"     │ "}
          </Text>
          <Text dimColor>{line}</Text>
        </Text>
      ))}
    </>
  );
}

const STUCK_COLOR = { abandoned: "red", fixing: "yellow", working: "green" } as const;

/** The executor has no child process to tail — show its in-flight work. */
function ExecutorPane({ paneH }: { paneH: number }) {
  const stuck = useSnapshot(poolStore).stuck;
  const rows = stuck.slice(0, paneH);
  return (
    <>
      {padLines(
        rows.map((s) => `${s.identifier} ${s.state}${s.reason ? ` — ${s.reason}` : ""}`),
        paneH,
      ).map((line, i) => {
        const item = rows[i];
        return (
          <Text key={i} wrap="truncate-end">
            <Text dimColor>{"     │ "}</Text>
            {item ? (
              <>
                <Text color={STUCK_COLOR[item.state]}>{item.state === "working" ? "●" : "◆"} </Text>
                <Text dimColor>{line}</Text>
              </>
            ) : (
              <Text dimColor>{i === 0 && rows.length === 0 ? "no in-flight work" : ""}</Text>
            )}
          </Text>
        );
      })}
    </>
  );
}
