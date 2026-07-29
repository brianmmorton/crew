import { proxy } from "valtio";
import type { PersonaName } from "../../types.js";

/**
 * The unified OUTPUT panel: one interleaved stream of everything happening —
 * the engine log (crew.log tail) plus every live agent run's stdout/stderr,
 * each line tagged with its source so the panel can color per agent.
 */

export type FeedLevel = "info" | "warn" | "error";

export interface FeedLine {
  /** Monotonic id — the stable React key that makes row memoization work. */
  id: number;
  /** null = engine log; otherwise the agent whose run produced the line. */
  source: PersonaName | null;
  /** Parsed from engine log lines; null for raw agent output. */
  level: FeedLevel | null;
  /** "HH:MM:SS" for engine log lines, else null. */
  time: string | null;
  text: string;
}

export const MAX_FEED_LINES = 500;

export const feedStore = proxy({
  lines: [] as FeedLine[],
});

let nextId = 1;

function push(lines: FeedLine[]): void {
  if (!lines.length) return;
  // Mutate rather than replace: valtio's structural sharing then keeps the
  // snapshot identity of every UNCHANGED line, which is what lets FeedRow's
  // memo() skip them — replacing the array would re-render the whole panel
  // on each append.
  feedStore.lines.push(...lines);
  const over = feedStore.lines.length - MAX_FEED_LINES;
  if (over > 0) feedStore.lines.splice(0, over);
}

/** `<ISO timestamp> <LEVEL> <message>` — the shape util/logger writes to file. */
const LOG_LINE = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\S*\s+(INFO|WARN|ERROR)\s+(.*)$/;

/** Append raw crew.log lines, parsing timestamp/level out of each. */
export function appendEngineLines(raw: string[]): void {
  push(
    raw.map((text) => {
      const m = LOG_LINE.exec(text);
      if (!m) return { id: nextId++, source: null, level: null, time: null, text };
      return {
        id: nextId++,
        source: null,
        level: m[3]!.toLowerCase() as FeedLevel,
        time: m[2]!,
        text: m[4]!,
      };
    }),
  );
}

/** Append an agent run's streamed output, tagged with the agent's name. */
export function appendAgentLines(agent: PersonaName, raw: string[]): void {
  push(raw.map((text) => ({ id: nextId++, source: agent, level: null, time: null, text })));
}

export function resetFeedStore(): void {
  feedStore.lines = [];
  nextId = 1;
}
