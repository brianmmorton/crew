import React from "react";
import { render } from "ink-testing-library";
import { LoadingSplash, Spinner } from "./Spinner.js";
import { RunView } from "./RunView.js";
import { AgentList } from "./AgentList.js";

console.log("--- LoadingSplash, 6 frames ---");
{
  const { lastFrame, unmount } = render(
    <LoadingSplash label="reading agents, tracker, and worktree pool…" />,
  );
  for (let i = 0; i < 6; i++) {
    console.log(lastFrame());
  }
  unmount();
}

console.log("\n--- RunView, running with no output yet ---");
{
  const run = {
    agent: "design",
    status: "running",
    startedAt: new Date(Date.now() - 3000),
    endedAt: null,
    lines: [],
    exitCode: null,
  } as any;
  console.log(render(<RunView run={run} height={20} />).lastFrame());
}

console.log("\n--- AgentList with a running row ---");
{
  const agentRows = [
    { agent: { name: "implementer", kind: "executor", cadence: "continuous", prompt: "", builtin: true }, next: null },
  ] as any;
  const runs = new Map([
    ["implementer", { agent: "implementer", status: "running", startedAt: new Date(), endedAt: null, lines: [], exitCode: null }],
  ]) as any;
  console.log(render(<AgentList rows={agentRows} runs={runs} selected={0} />).lastFrame());
}
