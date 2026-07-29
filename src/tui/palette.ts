/**
 * Stable per-agent colors for the accordion and the unified feed, so "which
 * agent said this" is a glance, not a read. Hash of the name rather than list
 * position: the color survives agents being added/removed/re-sorted.
 */

const AGENT_COLORS = [
  "cyan",
  "magenta",
  "green",
  "yellow",
  "blueBright",
  "magentaBright",
  "cyanBright",
  "greenBright",
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

export function agentColor(name: string): AgentColor {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length]!;
}

/** Engine-log level colors, matching util/logger's terminal styling. */
export const LEVEL_COLOR = { info: "blue", warn: "yellow", error: "red" } as const;
