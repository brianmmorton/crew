import { useRef } from "react";
import { debugEnabled, trace, count } from "./debug.js";

/**
 * Records that a component rendered, and — where it can tell — what changed
 * since its last render.
 *
 * A bare render count says which component is hot but not why, and in a tree
 * this small "why" is the whole question: LogPanel re-rendering 8×/second
 * means something very different if its `height` prop is changing (layout
 * thrash from the store) versus if `logLines` is (real new output). So each
 * caller passes the values it renders from, and this diffs them shallowly and
 * names the ones that moved.
 *
 * Values are compared with Object.is, so an unstable-identity value (a fresh
 * array or object rebuilt every tick) shows up as "changed" every render —
 * which is exactly the diagnosis you want when a component re-renders on a
 * value that is equal but not identical.
 */
export function useRenderTrace(name: string, watched?: Record<string, unknown>): void {
  const prev = useRef<Record<string, unknown> | undefined>(undefined);
  const renders = useRef(0);

  if (!debugEnabled()) return;

  renders.current += 1;
  const n = renders.current;
  const last = prev.current;
  prev.current = watched;

  count(`render:${name}`);

  if (!watched) {
    trace(`render:${name}`, () => `#${n}`);
    return;
  }
  if (!last) {
    trace(`render:${name}`, () => `#${n} (mount)`);
    return;
  }

  const changed: string[] = [];
  for (const key of Object.keys(watched)) {
    if (!Object.is(last[key], watched[key])) changed.push(key);
  }
  trace(`render:${name}`, () => `#${n} changed=[${changed.join(",")}]`);
}
