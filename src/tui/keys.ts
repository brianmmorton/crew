import type { Key } from "ink";

/**
 * Keyboard → intent, as pure data. The App's useInput handler translates a
 * keypress here and dispatches the returned action; keeping the mapping pure
 * makes every binding testable without a terminal.
 */

export type Action =
  | { type: "up" }
  | { type: "down" }
  | { type: "toggle-expand" }
  | { type: "collapse-all" }
  | { type: "run-selected" }
  | { type: "run-index"; index: number }
  | { type: "pause-agent" }
  | { type: "pause-pool" }
  | { type: "stop-agent" }
  | { type: "toggle-history" }
  | { type: "focus-next" }
  | { type: "focus-right" }
  | { type: "focus-left" }
  | { type: "open-board" }
  | { type: "quit" };

export function keyToAction(input: string, key: Partial<Key>): Action | null {
  if (key.ctrl && input === "c") return { type: "quit" };
  if (key.tab) return { type: "focus-next" };
  if (key.upArrow || input === "k") return { type: "up" };
  if (key.downArrow || input === "j") return { type: "down" };
  // ← / → move between the panels rather than expanding a row: the sidebar is
  // always open, so "arrow toward it" is the obvious way in and back out.
  // Enter still expands, which is what the agent accordion actually needs.
  if (key.rightArrow) return { type: "focus-right" };
  if (key.leftArrow) return { type: "focus-left" };
  if (key.return) return { type: "toggle-expand" };
  if (key.escape) return { type: "collapse-all" };
  if (input >= "1" && input <= "9" && input.length === 1) {
    return { type: "run-index", index: Number(input) - 1 };
  }
  switch (input) {
    case "r":
      return { type: "run-selected" };
    case " ":
      return { type: "pause-agent" };
    case "p":
      return { type: "pause-pool" };
    case "x":
      return { type: "stop-agent" };
    case "h":
      return { type: "toggle-history" };
    case "b":
      return { type: "open-board" };
    case "q":
      return { type: "quit" };
    default:
      return null;
  }
}

/**
 * The one-line legend the footer renders; lives here next to the bindings.
 * Focus-dependent, because ↑↓/⏎ mean different things in each list and a
 * legend that claims otherwise is worse than none.
 */
// "1-9 run №" still works but goes unadvertised: with `b board` added, the
// full list overruns a 100-column footer and the truncation eats `q quit`.
export const LEGEND =
  "↑↓ navigate · ⏎ expand · → history · r run · ␣ pause · p pool · b board · x stop · q quit";

export const HISTORY_LEGEND =
  "↑↓ navigate · ⏎ open link · ← back to agents · b board · h hide · q quit";
