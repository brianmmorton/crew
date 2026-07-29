import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Logo } from "./Logo.js";
import type { LogoArt } from "./logoArt.js";
import { traceCount } from "./debug.js";
import { useRenderTrace } from "./useRenderTrace.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

/**
 * One shared frame counter + timer for every mounted Spinner, rather than
 * each instance running its own setInterval. The TUI can have several
 * spinners live at once (one per running agent) — independent timers each
 * force their own out-of-phase Ink re-render, multiplying the full-screen
 * repaint rate by the spinner count. A single ticker keeps it at one
 * repaint per frame no matter how many spinners are on screen.
 */
let frame = 0;
const subscribers = new Set<() => void>();
let ticker: NodeJS.Timeout | null = null;

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  if (!ticker) {
    ticker = setInterval(() => {
      frame = (frame + 1) % FRAMES.length;
      // One tick fans out to every mounted Spinner, and each one is a React
      // state update — so the interesting number here is the subscriber count,
      // not the tick itself. N subscribers means N re-renders per 120ms.
      traceCount("spinner:tick", () => `frame=${frame} subscribers=${subscribers.size}`);
      for (const sub of subscribers) sub();
    }, FRAME_MS);
    // The animation is decoration; it must never be the reason the process is
    // still alive. Without this an exit path that leaves a spinner mounted
    // keeps the event loop busy at 120ms forever instead of letting node exit.
    ticker.unref?.();
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/** A quiet braille spinner, reused anywhere something is in flight but has no progress to show. */
export function Spinner({ color = "cyan" }: { color?: string }) {
  const [, forceRender] = useState(0);
  useRenderTrace("Spinner");
  useEffect(() => subscribe(() => forceRender((n) => n + 1)), []);
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
  // Driven off the same shared ticker as Spinner rather than a private 140ms
  // interval. Two independent timers meant two out-of-phase repaints of the
  // same frame, and the splash is on screen exactly when the logo fetch is
  // also landing and changing the frame's height — the worst moment to be
  // repainting on a clock nothing else is aligned to.
  const [, forceRender] = useState(0);
  useEffect(() => subscribe(() => forceRender((n) => n + 1)), []);
  const pos = frame % WORDMARK.length;
  useRenderTrace("LoadingSplash", { pos, logoArt });
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
