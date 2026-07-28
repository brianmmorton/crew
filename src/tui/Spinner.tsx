import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Logo } from "./Logo.js";
import type { LogoArt } from "./logoArt.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/** A quiet braille spinner, reused anywhere something is in flight but has no progress to show. */
export function Spinner({ color = "cyan" }: { color?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(timer);
  }, []);
  return <Text color={color}>{FRAMES[frame]}</Text>;
}

const WORDMARK = "crew";

/**
 * Startup splash: a cyan highlight chases across the "crew" wordmark like a
 * cursor scanning it, in place of a bare "loading…" — the first poll is doing
 * real work (tracker counts, agent defs, pool state) so it earns something
 * more deliberate than a spinner alone.
 */
export function LoadingSplash({ label, logoArt }: { label: string; logoArt?: LogoArt | null }) {
  const [pos, setPos] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPos((n) => (n + 1) % WORDMARK.length), 140);
    return () => clearInterval(timer);
  }, []);
  if (logoArt) {
    return (
      <Box flexDirection="column">
        <Logo art={logoArt} />
        <Text dimColor>{label}</Text>
      </Box>
    );
  }
  return (
    <Text>
      <Text bold>
        {WORDMARK.split("").map((ch, i) => (
          <Text key={i} color={i === pos ? "cyan" : undefined} dimColor={i !== pos}>
            {ch}
          </Text>
        ))}
      </Text>
      <Text dimColor>  {label}</Text>
    </Text>
  );
}
