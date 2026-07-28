import React from "react";
import { Box, Text } from "ink";
import type { LogoArt } from "./logoArt.js";

/** Renders a converted logo grid, one Ink Text row per pixel row. */
export function Logo({ art }: { art: LogoArt }) {
  return (
    <Box flexDirection="column">
      {art.map((row, y) => (
        <Text key={y}>
          {row.map((cell, x) => (
            <Text key={x} color={cell.color}>
              {cell.ch}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
