import React from "react";
import { render } from "ink";
import type { CrewConfig } from "../types.js";
import { App } from "./App.js";
import { silenceConsole } from "../util/logger.js";

/**
 * Launch the live status TUI. Runs until the user presses q/Esc or ctrl-c.
 *
 * `verbose` turns on the render trace (see tui/debug.ts), written to
 * <configDir>/logs/tui-debug.log — a per-frame record of which components
 * re-rendered and why, for diagnosing flicker.
 */
export async function runTui(cfg: CrewConfig, verbose = false): Promise<void> {
  // While the TUI owns the screen, log lines go to the file only. The LOG
  // panel tails that same file, so this is the same content — but routed
  // through React instead of written raw into the middle of Ink's frame.
  silenceConsole(true);

  // patchConsole defaults to true, which routes console output around the
  // frame but forces a full repaint per line. With the logger silenced above
  // there's nothing left to intercept, so it's pure overhead.
  //
  // incrementalRendering stays OFF (Ink's default) despite sounding like the
  // obvious win. Ink 6.8's incremental path is unsound on any frame that grows:
  // it emits `cursorUp(previousVisible - 1)` and then descends over
  // `visibleCount` lines — including a `cursorNextLine` for each *unchanged*
  // line it skips rewriting — so when the frame gained a line it walks down
  // one row further than it climbed. The block's anchor drifts, and every
  // later repaint compounds it. That was the "design ⠋ running" ladder: not
  // the spinner redrawing wrongly, but the frame beneath it having moved.
  //
  // With it off, Ink erases the previous block and rewrites it, which is
  // anchor-safe at any height. The cost that used to justify incremental is
  // handled at the source instead — the frame is kept a stable height (see
  // RunView) and the spinner only repaints while something is genuinely in
  // flight, so a full rewrite is rare and small.
  const { waitUntilExit } = render(<App cfg={cfg} verbose={verbose} />, {
    patchConsole: false,
  });
  try {
    await waitUntilExit();
  } finally {
    silenceConsole(false);
  }
}
