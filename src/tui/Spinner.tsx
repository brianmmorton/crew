import { useSyncExternalStore } from "react";
import { Text } from "ink";

/**
 * One module-wide 120ms ticker shared by every animated glyph on screen.
 * Per-component setIntervals would drift apart and wake the process N times
 * per frame; here the timer exists only while at least one subscriber is
 * mounted, and is unref'd so it never holds the process open.
 */

let frame = 0;
let timer: NodeJS.Timeout | null = null;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    timer = setInterval(() => {
      frame++;
      for (const l of listeners) l();
    }, 120);
    timer.unref?.();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current animation frame counter; re-renders the caller at ~8fps. */
export function useTick(): number {
  return useSyncExternalStore(subscribe, () => frame, () => 0);
}

const DOTS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ color = "cyan" }: { color?: string }): React.ReactNode {
  const t = useTick();
  return <Text color={color}>{DOTS[t % DOTS.length]}</Text>;
}
