import React from "react";
import { render } from "ink";
import type { CrewConfig } from "../types.js";
import { App } from "./App.js";
import { silenceConsole } from "../util/logger.js";

/** Launch the live status TUI. Runs until the user presses q/Esc or ctrl-c. */
export async function runTui(cfg: CrewConfig): Promise<void> {
  // While the TUI owns the screen, log lines go to the file only. The LOG
  // panel tails that same file, so this is the same content — but routed
  // through React instead of written raw into the middle of Ink's frame.
  silenceConsole(true);

  // Two Ink defaults are wrong for this app:
  //
  // - incrementalRendering defaults to false, so Ink erases and rewrites
  //   every visible line on any change instead of diffing against the
  //   previous frame.
  // - patchConsole defaults to true, which routes console output around the
  //   frame but forces a full repaint per line. With the logger silenced
  //   above there's nothing left to intercept, so it's pure overhead.
  const { waitUntilExit } = render(<App cfg={cfg} />, {
    incrementalRendering: true,
    patchConsole: false,
  });
  try {
    await waitUntilExit();
  } finally {
    silenceConsole(false);
  }
}
