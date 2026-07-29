/**
 * Frame budgeting. Ink 6.8's `incrementalRendering` is only anchor-safe while
 * the frame never GROWS between paints — growth slides the anchor and every
 * later repaint compounds it (the stacked-spinner "ladder"). So the whole
 * screen is built from one constant-height budget: expanding a pane takes
 * rows FROM the feed, never from thin air. tui.test.tsx guards this.
 *
 * `rows - 2` (not `rows - 1`): a frame at full height flips Ink into
 * fullscreen mode where it clears the terminal on every paint.
 */

/** Header (2) + AGENTS title (1) + OUTPUT title (1) + footer (1). */
const CHROME = 5;
export const MIN_FEED = 3;
export const PANE_MIN = 3;
export const PANE_MAX = 8;

export interface Layout {
  /** Total frame height handed to Ink — constant for a given terminal size. */
  frameH: number;
  /** Visible agent rows (the list windows around the cursor when short). */
  listRows: number;
  /** Height of EACH expanded pane; 0 = no room to expand at all. */
  paneH: number;
  /** Unified output height — absorbs whatever the accordion doesn't use. */
  feedH: number;
}

export function computeLayout(rows: number, agentCount: number, expandedCount: number): Layout {
  const frameH = Math.max(12, rows - 2);
  const budget = frameH - CHROME;

  // Agents get their rows first, but never so many that the feed vanishes.
  const listRows = Math.min(Math.max(agentCount, 1), Math.max(1, budget - MIN_FEED));
  const afterList = budget - listRows;

  let paneH = 0;
  if (expandedCount > 0) {
    paneH = Math.min(PANE_MAX, Math.floor((afterList - MIN_FEED) / expandedCount));
    if (paneH < PANE_MIN) paneH = 0; // too tight — accordion markers only
  }

  const feedH = Math.max(1, afterList - paneH * expandedCount);
  return { frameH, listRows, paneH, feedH };
}

/**
 * First index of the visible window over `count` items, keeping `selected`
 * centered where possible. Pure so the scrolling math is testable.
 */
export function windowStart(count: number, visible: number, selected: number): number {
  if (count <= visible) return 0;
  const centered = selected - Math.floor(visible / 2);
  return Math.min(count - visible, Math.max(0, centered));
}

/** "MM:SS" (or "H:MM:SS") elapsed between two epoch-ms instants. */
export function fmtElapsed(from: number, to: number): string {
  const s = Math.max(0, Math.floor((to - from) / 1000));
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** "in 3h" / "in 12m" / "due" until an epoch-ms instant. */
export function fmtUntil(at: number, now: number): string {
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return "due";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.floor(h / 24)}d`;
}
