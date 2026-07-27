/**
 * Minimal ANSI styling for terminal output. Deliberately dependency-free: crew
 * ships as a CLI people install globally, and a color library is not worth a
 * transitive dependency for eight escape codes.
 *
 * Colors are applied ONLY to the stderr copy of a log line. The file sink gets
 * the plain string, so `grep` and `tail -f` on <configDir>/logs/crew.log stay
 * readable and machine-parseable. See `src/util/logger.ts`.
 */

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  underline: 4,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

export type Style = keyof typeof CODES;

/**
 * Whether to emit escape codes. Honors the two conventions that matter:
 * NO_COLOR (any value disables) and FORCE_COLOR (any value except "0" enables,
 * so colors survive being piped into a pager or a CI log that renders them).
 * Otherwise: only when stderr is a TTY and TERM isn't "dumb".
 */
function detectColor(): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0";
  if (env.TERM === "dumb") return false;
  return !!process.stderr.isTTY;
}

let enabled = detectColor();

/** Re-read the environment (tests, and `--no-color` handling). */
export function setColorEnabled(on: boolean): void {
  enabled = on;
}

export function colorEnabled(): boolean {
  return enabled;
}

/** Wrap `s` in one or more styles, or return it untouched when colors are off. */
export function style(s: string, ...styles: Style[]): string {
  if (!enabled || !s) return s;
  const open = styles.map((k) => `\x1b[${CODES[k]}m`).join("");
  return `${open}${s}\x1b[${CODES.reset}m`;
}

/** Strip every ANSI escape sequence — used for the plain file copy. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
