import { render } from "ink";
import type { CrewConfig } from "../types.js";
import { silenceConsole } from "../util/logger.js";
import { App } from "./App.js";

/**
 * Launch the live TUI. Runs until the user presses q or ctrl-c.
 *
 * `verbose` turns on the render trace (see tui/debug.ts), written to
 * <configDir>/logs/tui-debug.log.
 */
export async function runTui(cfg: CrewConfig, verbose = false): Promise<void> {
  // While the TUI owns the screen, log lines go to the file only — the
  // OUTPUT panel tails that same file back in, routed through React instead
  // of written raw into the middle of Ink's frame.
  silenceConsole(true);

  // patchConsole would be pure overhead with the logger silenced above.
  //
  // incrementalRendering rewrites only the lines that changed instead of
  // erasing and reprinting the whole block. Its hard prerequisite — the frame
  // must never grow between paints — is enforced by the layout budget: every
  // screen is pinned to a constant height (see layout.ts), and `rows - 2`
  // rather than full height because a full-height frame flips Ink into
  // fullscreen mode, which clears the terminal on every paint.
  const { waitUntilExit, unmount } = render(<App cfg={cfg} verbose={verbose} />, {
    incrementalRendering: true,
    patchConsole: false,
  });

  // Ink handles ctrl-c itself (unmount → App teardown drains the executor
  // and kills live `crew once` children). SIGTERM and uncaught throws get no
  // such treatment: without this the process dies with the console still
  // silenced and children reparented to init. Re-raise after cleanup rather
  // than process.exit so the exit code stays the conventional 128+signal.
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    unmount();
    silenceConsole(false);
  };
  const onSignal = (signal: NodeJS.Signals) => () => {
    cleanup();
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await waitUntilExit();
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    cleanup();
  }
}
