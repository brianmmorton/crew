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
  | { type: "quit" };

export function keyToAction(input: string, key: Partial<Key>): Action | null {
  if (key.ctrl && input === "c") return { type: "quit" };
  if (key.upArrow || input === "k") return { type: "up" };
  if (key.downArrow || input === "j") return { type: "down" };
  if (key.return || key.rightArrow || key.leftArrow) return { type: "toggle-expand" };
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
    case "q":
      return { type: "quit" };
    default:
      return null;
  }
}

/** The one-line legend the footer renders; lives here next to the bindings. */
export const LEGEND =
  "↑↓ navigate · ⏎ expand · r run · 1-9 run № · ␣ pause agent · p pause pool · x stop · q quit";
