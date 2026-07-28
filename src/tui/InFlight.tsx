import React from "react";
import { Box, Text } from "ink";
import type { StuckItem } from "../engine/stuck.js";

const STATE_COLOR: Record<StuckItem["state"], string> = {
  abandoned: "red",
  fixing: "yellow",
  working: "green",
};

function tries(item: StuckItem): string {
  const parts = [
    item.verifyTries ? `verify ${item.verifyTries}` : "",
    item.landTries ? `land ${item.landTries}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

export function InFlight({
  items,
  total,
}: {
  items: readonly StuckItem[];
  /** Full count before the frame truncated the list, for the header. */
  total?: number;
}) {
  if (items.length === 0) return null;
  const count = total ?? items.length;
  const abandoned = items.filter((i) => i.state === "abandoned").length;
  const hidden = count - items.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold underline>
        IN FLIGHT ({count}){abandoned ? `  ${abandoned} abandoned` : ""}
        {hidden > 0 ? `  +${hidden} more` : ""}
      </Text>
      {items.map((item) => (
        <Box key={item.identifier}>
          <Box width={14}>
            <Text color="cyan">{item.identifier}</Text>
          </Box>
          <Box width={13}>
            <Text color={STATE_COLOR[item.state]}>{item.state}</Text>
          </Box>
          <Box width={18}>
            <Text dimColor>{tries(item)}</Text>
          </Box>
          <Text wrap="truncate-end" dimColor>
            {item.reason ?? ""}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
