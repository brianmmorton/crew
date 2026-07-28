import React from "react";
import { render } from "ink";
import type { CrewConfig } from "../types.js";
import { App } from "./App.js";

/** Launch the live status TUI. Runs until the user presses q/Esc or ctrl-c. */
export async function runTui(cfg: CrewConfig): Promise<void> {
  const { waitUntilExit } = render(<App cfg={cfg} />);
  await waitUntilExit();
}
