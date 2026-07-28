/**
 * Dev-only story browser: renders the real TUI components against the
 * fixtures in stories.tsx, so a layout can be looked at without a tracker,
 * a repo, or a live agent — including the states that are awkward to reach
 * on purpose (an error frame, an abandoned claim, a 12-row terminal).
 *
 * Run from a checkout with `npm run stories`. Deliberately not wired into
 * the `crew` CLI: it is developer tooling, not a shipped command.
 *
 *   npm run stories                  # browse, ←/→ to switch, q to quit
 *   npm run stories -- narrow        # open one by name
 *   npm run stories -- narrow 12     # ...and force a terminal height
 *   npm run stories -- list          # print the catalog and exit
 */
import React from "react";
import { render, useApp, useInput, Box, Text } from "ink";
import { Screen } from "./App.js";
import { stories, getStory, applyStory } from "./stories.js";
import { store } from "./store.js";

/** Renders one story with ←/→ to page through the rest, and q to quit. */
function StoryBrowser({ start, rows }: { start: string; rows?: number }) {
  const { exit } = useApp();
  const [index, setIndex] = React.useState(
    Math.max(0, stories.findIndex((s) => s.name === start)),
  );
  const story = stories[index];

  // Applied in an effect rather than during render: applyStory mutates the
  // store, and doing that mid-render re-enters the renderer.
  React.useEffect(() => {
    applyStory(story);
    // The banner below costs two rows that Screen's own budget can't see, so
    // an explicit height means "the app gets this many" and the banner is
    // charged on top.
    if (rows && Number.isFinite(rows)) store.rows = rows - 2;
  }, [index, rows, story]);

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
    else if (key.leftArrow) setIndex((i) => (i - 1 + stories.length) % stories.length);
    else if (key.rightArrow) setIndex((i) => (i + 1) % stories.length);
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text backgroundColor="cyan" color="black">
          {` story ${index + 1}/${stories.length}: ${story.name} `}
        </Text>
        <Text dimColor>{`  ${story.description}  ·  [←→] switch  [q] quit`}</Text>
      </Box>
      <Screen implWorkers={1} />
    </Box>
  );
}

const [name, rowsArg] = process.argv.slice(2);

if (name === "list") {
  const width = Math.max(...stories.map((s) => s.name.length));
  for (const s of stories) {
    process.stdout.write(`  ${s.name.padEnd(width)}  ${s.description}\n`);
  }
} else if (name && !getStory(name)) {
  process.stderr.write(`unknown story "${name}". Run \`npm run stories -- list\` to see them.\n`);
  process.exitCode = 1;
} else {
  const rows = rowsArg ? Number.parseInt(rowsArg, 10) : undefined;
  // No executor and no poller, so nothing mutates the store except the
  // switcher above — the frame is whatever the fixture describes.
  render(<StoryBrowser start={name ?? stories[0].name} rows={rows} />, {
    incrementalRendering: true,
    patchConsole: false,
  });
}
