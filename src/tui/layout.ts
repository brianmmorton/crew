/**
 * Frame budgeting. `incrementalRendering` repaints lines relative to a cursor
 * anchor, so the frame must never GROW past the terminal bottom between
 * paints — the overflow scrolls the terminal and the scrolled-off lines are
 * left behind as ghosts Ink can no longer erase. So the whole screen is built
 * from one constant-height budget: expanding a pane takes rows FROM the feed,
 * never from thin air. tui.test.tsx guards this.
 *
 * Requires ink >= 7: 6.8.0's incremental renderer rewound the cursor with
 * `cursorUp(previousVisible - 1)` — one row short for a frame with a trailing
 * newline — so EVERY repaint slid the frame down a row, duplicating rows and
 * stacking ghost header/footer lines. Ink 7 rewinds by the full line count.
 *
 * `rows - 2` (not `rows - 1`): a frame at full height flips Ink into
 * fullscreen mode where it clears the terminal on every paint.
 */

/**
 * Header (2) + footer (1) + the AGENTS and OUTPUT panels' border rows (2
 * each — title-in-border top line + bottom edge, see Panel.tsx).
 */
const CHROME = 7;
export const MIN_FEED = 3;
export const PANE_MIN = 3;
export const PANE_MAX = 8;

/**
 * Sidebar width budgeting. Unlike the height budget above, this is about
 * COLUMNS: taking width away from the main column truncates real content
 * (agent rows shed their kind/schedule cells responsively, but below ~50
 * columns even the name + status pair gets crushed).
 *
 * Below SIDEBAR_MIN_COLUMNS the sidebar is simply not drawn — a squeezed
 * agent row is worse than no history at all.
 */
export const SIDEBAR_W = 32;
export const SIDEBAR_MAX_W = 76;
export const SIDEBAR_FOCUS_MAX_W = 96;
export const SIDEBAR_MIN_COLUMNS = 100;

/**
 * Sidebar width for a terminal width: 0 when too narrow or the user has it
 * off, otherwise about a third of the terminal — and closer to half while the
 * panel is FOCUSED. The panel's content is text worth reading (PR urls,
 * failure reasons), and focusing it is the "I want to read this now" gesture,
 * so that's when it earns the extra columns: at ~72+ inner columns a GitHub
 * PR url survives untruncated and stays cmd+clickable. Blurring hands the
 * width back to the agent rows and feed. Pure, so the thresholds are tested
 * rather than eyeballed.
 */
export function sidebarWidth(columns: number, visible: boolean, focused = false): number {
  if (!visible || columns < SIDEBAR_MIN_COLUMNS) return 0;
  const share = focused ? Math.floor(columns * 0.45) : Math.floor(columns / 3) - 4;
  const cap = focused ? SIDEBAR_FOCUS_MAX_W : SIDEBAR_MAX_W;
  return Math.max(SIDEBAR_W, Math.min(cap, share));
}

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
