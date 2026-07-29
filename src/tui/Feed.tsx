import { memo } from "react";
import { Box, Text } from "ink";
import { useSnapshot } from "valtio";
import { feedStore, type FeedLine } from "./stores/feed.js";
import { agentColor, LEVEL_COLOR } from "./palette.js";

/**
 * The unified OUTPUT panel: engine log + every agent run, interleaved in
 * arrival order. Rows are memoized and keyed by their monotonic id, and the
 * feed store mutates its array in place, so an append re-renders only the
 * rows that scrolled into view — not the whole panel.
 */

export const Feed = memo(function Feed({ height }: { height: number }): React.ReactNode {
  const lines = useSnapshot(feedStore).lines;
  const shown = lines.slice(-height);
  const pad = height - shown.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {shown.map((line) => (
        <FeedRow key={line.id} line={line} />
      ))}
      {pad > 0 &&
        Array.from({ length: pad }, (_, i) => (
          <Text key={`pad-${i}`} dimColor>
            {" "}
          </Text>
        ))}
    </Box>
  );
});

const FeedRow = memo(function FeedRow({ line }: { line: FeedLine }): React.ReactNode {
  if (line.source) {
    // An agent run's raw output, tagged and tinted by owner.
    return (
      <Text wrap="truncate-end">
        <Text color={agentColor(line.source)} bold>
          {" "}
          {line.source.padEnd(9)}
        </Text>
        <Text dimColor>{line.text}</Text>
      </Text>
    );
  }
  if (line.level) {
    return (
      <Text wrap="truncate-end">
        <Text dimColor> {line.time} </Text>
        <Text color={LEVEL_COLOR[line.level]} bold={line.level !== "info"}>
          {line.level.toUpperCase().padEnd(5)}
        </Text>
        <Text> {line.text}</Text>
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text dimColor> {line.text}</Text>
    </Text>
  );
});
