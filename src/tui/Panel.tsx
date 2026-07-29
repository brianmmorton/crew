import { memo } from "react";
import { Box, Text } from "ink";

/**
 * The bordered frame every dashboard section lives in. The title sits IN the
 * top border (`╭─ AGENTS ── hint ─╮`) rather than on its own row, so a panel
 * costs exactly 2 rows of chrome — one custom top line, one Ink-drawn bottom —
 * and the layout math can budget it as a constant (see layout.ts PANEL_CHROME).
 *
 * The top line is hand-built because Ink borders can't embed a label; the
 * sides and bottom are Ink's own `borderStyle="round"` with the top edge
 * switched off, so the two halves share corner glyphs seamlessly.
 *
 * Focus is a border-color change, not a layout change: the focused panel's
 * frame and title switch to the accent color, everything else stays dim gray.
 */

/** Rows a panel adds around its content: top border + bottom border. */
export const PANEL_CHROME = 2;

/** Columns a panel adds around its content: left + right border. */
export const PANEL_CHROME_W = 2;

export interface TopBorderParts {
  /** "╭─ " */
  left: string;
  /** The (possibly truncated) title. */
  title: string;
  /** " ───…─" run between title and hint. */
  fill: string;
  /** " hint " or "" when the hint doesn't fit. */
  hint: string;
  /** "─╮" */
  right: string;
}

/**
 * Build the top border segments for a given width. Pure and exact: the joined
 * parts are always `width` characters, so the line can never wrap or fall
 * short of the panel's right edge. Exported for tests.
 */
export function topBorderParts(width: number, title: string, hint?: string): TopBorderParts {
  const left = "╭─ ";
  const right = "─╮";
  let t = title;
  let h = hint ? ` ${hint} ` : "";
  // space after title + dashes to the hint (or corner).
  let fill = width - left.length - right.length - t.length - 1 - h.length;
  if (fill < 1 && h) {
    h = "";
    fill = width - left.length - right.length - t.length - 1;
  }
  if (fill < 1) {
    t = t.slice(0, Math.max(0, t.length + fill - 1));
    fill = width - left.length - right.length - t.length - 1;
  }
  return { left, title: t, fill: ` ${"─".repeat(Math.max(0, fill))}`, hint: h, right };
}

export const Panel = memo(function Panel({
  title,
  hint,
  width,
  height,
  focused = false,
  accent = "cyan",
  children,
}: {
  title: string;
  hint?: string;
  width: number;
  height: number;
  focused?: boolean;
  accent?: string;
  children: React.ReactNode;
}): React.ReactNode {
  if (height < PANEL_CHROME || width < 4) return null;
  const parts = topBorderParts(width, title, hint);
  const borderColor = focused ? accent : "gray";
  return (
    <Box flexDirection="column" width={width} height={height} flexShrink={0} flexGrow={0}>
      <Text wrap="truncate-end">
        <Text color={borderColor} dimColor={!focused}>
          {parts.left}
        </Text>
        <Text bold color={focused ? accent : undefined} dimColor={!focused}>
          {parts.title}
        </Text>
        <Text color={borderColor} dimColor={!focused}>
          {parts.fill}
        </Text>
        {parts.hint !== "" && <Text dimColor>{parts.hint}</Text>}
        <Text color={borderColor} dimColor={!focused}>
          {parts.right}
        </Text>
      </Text>
      <Box
        flexDirection="column"
        width={width}
        height={height - 1}
        flexShrink={0}
        borderStyle="round"
        borderTop={false}
        borderColor={borderColor}
        borderDimColor={!focused}
      >
        {children}
      </Box>
    </Box>
  );
});
