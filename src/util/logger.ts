import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../types.js";
import { style, stripAnsi, type Style } from "./color.js";

/** How each level is painted. Only the tag is colored, not the whole line. */
const LEVEL_STYLE: Record<string, Style[]> = {
  "INFO ": ["blue"],
  "WARN ": ["yellow", "bold"],
  ERROR: ["red", "bold"],
};

/**
 * Highlight the parts of a message a human scans for. These are cosmetic and
 * must never change the text itself — the file copy is the same string with the
 * escapes stripped, so anything added here has to survive `stripAnsi`.
 */
function paintMessage(msg: string): string {
  // Paths and URLs are painted as single units and never re-scanned, because a
  // run-log filename embeds the issue key (…/verify-ABC-1-FAILED.log) and the
  // key regex would otherwise recolor the middle of the path.
  // Trailing punctuation is excluded so a path in parentheses or at the end of
  // a sentence doesn't drag the ")" or "." into the colored span.
  const TOKEN = /(https?:\/\/[^\s)]*[^\s).,;:]|(?:[^\s/)]*\/)+[^\s)]*[^\s).,;:])/g;
  const parts = msg.split(TOKEN);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        return part.startsWith("http")
          ? style(part, "magenta", "underline")
          : style(part, "magenta");
      }
      return (
        part
          // Issue keys (ABC-123) — what you grep for when tracing one ticket.
          .replace(/\b([A-Z][A-Z0-9]+-\d+)\b/g, (m) => style(m, "cyan", "bold"))
          // Outcomes worth spotting without reading the whole sentence.
          .replace(/\b(passed|opened PR|PR opened)\b/g, (m) => style(m, "green"))
          .replace(/\b(failed|rejected|no commit|giving up|refused)\b/g, (m) => style(m, "red"))
      );
    })
    .join("");
}

function fmt(level: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const extra = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return (
    style(ts, "gray") +
    " " +
    style(level, ...(LEVEL_STYLE[level] ?? [])) +
    " " +
    paintMessage(msg) +
    style(extra, "dim")
  );
}

let sink: WriteStream | null = null;

/** Also append log lines to a file (in addition to stderr). Best-effort. */
export function logToFile(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    sink = createWriteStream(filePath, { flags: "a" });
  } catch {
    /* file logging is best-effort; stderr still works */
  }
}

/** Log file inside the project's crew dir: <configDir>/logs/crew.log (override CREW_LOG_DIR). */
export function logFilePath(configDir: string): string {
  const dir = process.env.CREW_LOG_DIR?.trim() || join(configDir, "logs");
  return join(dir, "crew.log");
}

function emit(level: string, msg: string, meta?: Record<string, unknown>): void {
  const line = fmt(level, msg, meta);
  console.error(line);
  // The file is for grepping and for pasting into an issue, so it never gets
  // escape codes — even when the terminal copy is colored.
  sink?.write(stripAnsi(line) + "\n");
}

/** stderr logger that optionally mirrors to a file (see logToFile). */
export const logger: Logger = {
  info: (m, meta) => emit("INFO ", m, meta),
  warn: (m, meta) => emit("WARN ", m, meta),
  error: (m, meta) => emit("ERROR", m, meta),
};
