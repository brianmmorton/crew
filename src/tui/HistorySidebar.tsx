import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { highlights, type Highlight, type RunOutcome, type Session } from "../util/runindex.js";
import { historyStore } from "./stores/history.js";
import { appStore } from "./stores/app.js";
import { windowStart } from "./layout.js";
import { agentColor } from "./palette.js";

/**
 * The history sidebar: what recent runs PRODUCED, newest first — a PR link,
 * the tickets filed, or the error that stopped the run. Deliberately not a log
 * viewer: the full transcript still lives at the path in the run index, and
 * the panel's job is to answer "what happened" without opening anything.
 *
 * Subscription shape mirrors AgentsPanel: rows take primitive props only, so
 * moving the cursor re-renders exactly the two rows that changed, and the
 * title line subscribes to focus by itself so Tab repaints one line.
 */

const OUTCOME = {
  ok: { glyph: "✔", color: "green" },
  failed: { glyph: "✘", color: "red" },
  rejected: { glyph: "⊘", color: "yellow" },
  "usage-limited": { glyph: "◷", color: "yellow" },
} as const satisfies Record<RunOutcome, { glyph: string; color: string }>;

/** Color per highlight kind — the same vocabulary the feed uses for levels. */
const HIGHLIGHT_COLOR = {
  pr: "magenta",
  created: "cyan",
  error: "red",
  info: "gray",
} as const;

/** Leading marker per highlight kind, so the line reads without color alone. */
const HIGHLIGHT_MARK = {
  pr: "⎇",
  created: "＋",
  error: "!",
  info: "·",
} as const;

export const HistorySidebar = memo(function HistorySidebar({
  width,
  height,
}: {
  width: number;
  height: number;
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={width} flexShrink={0} flexGrow={0}>
      <SidebarTitle width={width} />
      <SessionList width={width} height={Math.max(0, height - 1)} />
    </Box>
  );
});

const SidebarTitle = memo(function SidebarTitle({ width }: { width: number }): React.ReactNode {
  const focused = useSnapshot(appStore).focus === "history";
  const hint = focused ? "← back" : "→ open";
  const label = " RECENT";
  const gap = Math.max(1, width - label.length - hint.length - 1);
  return (
    <Text wrap="truncate-end">
      <Text bold color={focused ? "blueBright" : "gray"}>
        {label}
      </Text>
      <Text dimColor>{" ".repeat(gap)}</Text>
      <Text dimColor>{hint}</Text>
    </Text>
  );
});

/**
 * The scrollable list. Always renders exactly `height` rows — short history is
 * padded — so the sidebar can never change the frame height (see layout.ts).
 *
 * Each session costs a header row plus one row per highlight, so the window is
 * measured in ROWS rather than sessions: a session is only drawn if its whole
 * block fits, which keeps a half-rendered entry off the bottom edge.
 */
const SessionList = memo(function SessionList({
  width,
  height,
}: {
  width: number;
  height: number;
}): React.ReactNode {
  const snap = useSnapshot(historyStore);
  const sessions = snap.sessions as Session[];
  const { selected } = snap;

  if (height <= 0) return null;
  if (sessions.length === 0) {
    return (
      <>
        <Text dimColor wrap="truncate-end">
          {"  no completed runs yet"}
        </Text>
        {pad(height - 1)}
      </>
    );
  }

  // Start from a session-level window so the cursor stays visible, then fill
  // rows until the budget runs out.
  const start = windowStart(sessions.length, Math.max(1, Math.floor(height / 2)), selected);
  const rows: React.ReactNode[] = [];
  let used = 0;
  for (let i = start; i < sessions.length; i++) {
    const s = sessions[i]!;
    const lines = highlights(s);
    const cost = 1 + lines.length;
    // Always draw the selected session even if only its header fits.
    if (used + cost > height && !(i === selected && used < height)) break;
    rows.push(
      <SessionBlock
        key={s.key}
        label={s.label}
        title={s.title}
        outcome={s.outcome}
        agent={s.agents[0]}
        at={s.at}
        lines={lines}
        isSelected={i === selected}
        width={width}
        maxLines={Math.max(0, height - used - 1)}
      />,
    );
    used += Math.min(cost, height - used);
    if (used >= height) break;
  }

  return (
    <>
      {rows}
      {pad(height - used)}
    </>
  );
});

/** Blank filler rows, so the frame height never depends on content. */
function pad(n: number): React.ReactNode[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => <Text key={`pad-${i}`}> </Text>);
}

/**
 * One session: a header line, then its highlights. Props are primitives plus
 * a small frozen array, so memo() short-circuits on an unrelated cursor move.
 */
const SessionBlock = memo(
  function SessionBlock({
    label,
    title,
    outcome,
    agent,
    at,
    lines,
    isSelected,
    width,
    maxLines,
  }: {
    label: string;
    title?: string;
    outcome: RunOutcome;
    agent?: string;
    at: number;
    lines: Highlight[];
    isSelected: boolean;
    width: number;
    maxLines: number;
  }): React.ReactNode {
    const mark = OUTCOME[outcome];
    // Header chrome: cursor(2) + glyph(2) + time(7) = 11 columns.
    const headW = Math.max(6, width - 11);
    const head = title ? `${label} ${title}` : label;
    return (
      <>
        <Text wrap="truncate-end">
          <Text color="cyanBright">{isSelected ? " ❯" : "  "}</Text>
          <Text color={mark.color}>{` ${mark.glyph}`}</Text>
          <Text dimColor>{` ${fmtClock(at)} `}</Text>
          <Text color={agent ? agentColor(agent) : undefined} bold={isSelected}>
            {ellipsize(head, headW)}
          </Text>
        </Text>
        {lines.slice(0, maxLines).map((h, i) => (
          <HighlightRow key={i} kind={h.kind} text={h.text} width={width} />
        ))}
      </>
    );
  },
  (a, b) =>
    a.label === b.label &&
    a.title === b.title &&
    a.outcome === b.outcome &&
    a.agent === b.agent &&
    a.at === b.at &&
    a.isSelected === b.isSelected &&
    a.width === b.width &&
    a.maxLines === b.maxLines &&
    // Highlights are derived fresh each render, so compare by value — a
    // reference check here would defeat the memo entirely.
    a.lines.length === b.lines.length &&
    a.lines.every((l, i) => l.kind === b.lines[i]?.kind && l.text === b.lines[i]?.text),
);

const HighlightRow = memo(function HighlightRow({
  kind,
  text,
  width,
}: {
  kind: Highlight["kind"];
  text: string;
  width: number;
}): React.ReactNode {
  // Indent(5) + mark(1) + space(1) = 7 columns of chrome.
  const w = Math.max(6, width - 7);
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{"     "}</Text>
      <Text color={HIGHLIGHT_COLOR[kind]}>{HIGHLIGHT_MARK[kind]}</Text>
      <Text dimColor>{` ${ellipsize(text, w)}`}</Text>
    </Text>
  );
});

/**
 * Truncate to `w` with a trailing ellipsis. Deliberately does NOT pad: the
 * cells to the left are already fixed-width, and padding to the full remaining
 * width pushes trailing content past the sidebar edge, where Ink truncates it
 * again and produces a doubled ellipsis.
 */
function ellipsize(text: string, w: number): string {
  if (text.length <= w) return text;
  return `${text.slice(0, Math.max(0, w - 1))}…`;
}

/** "HH:MM" for today's runs, "MM/DD" for older ones. */
function fmtClock(at: number): string {
  if (!at) return "  :  ";
  const d = new Date(at);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}
