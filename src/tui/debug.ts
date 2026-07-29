import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Render tracing for diagnosing TUI flicker. Off unless `crew tui --verbose`
 * turned it on, and cheap enough when off (`enabled` is a plain boolean check)
 * to leave the call sites in permanently.
 *
 * Deliberately NOT routed through `util/logger` even though that already has a
 * file sink. The TUI tails `crew.log` into its own LOG panel, so a trace line
 * written there would change `store.logLines`, re-render LogPanel, and emit
 * another trace line — the tracer would manufacture exactly the flicker it is
 * supposed to be measuring. This gets its own file, which nothing reads back.
 */

let sink: WriteStream | null = null;
let enabled = false;
let t0 = 0;
let path = "";

/** Where `--verbose` writes: <configDir>/logs/tui-debug.log (honours CREW_LOG_DIR). */
export function debugFilePath(configDir: string): string {
  const dir = process.env.CREW_LOG_DIR?.trim() || join(configDir, "logs");
  return join(dir, "tui-debug.log");
}

/**
 * Begin tracing to `filePath`. Truncates rather than appends: a flicker trace
 * is read as one continuous timeline, and a previous session's frames
 * interleaved at the top make the per-second rates misleading.
 */
export function startDebug(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    sink = createWriteStream(filePath, { flags: "w" });
    path = filePath;
    enabled = true;
    t0 = Date.now();
    counts.clear();
    sink.write(
      `# crew tui render trace  started=${new Date().toISOString()}\n` +
        `# columns: <ms since start> <event> <detail>\n`,
    );
  } catch {
    /* tracing is best-effort; never take the TUI down over it */
  }
}

export function debugEnabled(): boolean {
  return enabled;
}

/** Milliseconds since tracing began — the timeline every line is stamped on. */
export function since(): number {
  return enabled ? Date.now() - t0 : 0;
}

/**
 * Write one trace line. `detail` is a thunk so that building the (often
 * expensive: JSON.stringify of a snapshot diff) detail string is skipped
 * entirely when tracing is off.
 */
export function trace(event: string, detail?: () => string): void {
  if (!enabled || !sink) return;
  const d = detail ? " " + detail() : "";
  sink.write(`${String(since()).padStart(8)} ${event.padEnd(22)}${d}\n`);
}

/**
 * Per-event counters, dumped on exit. The trace lines say *when* things
 * happened; this says which of them dominated over the whole session, which is
 * the number that actually identifies the culprit.
 */
const counts = new Map<string, number>();

export function count(event: string): void {
  if (!enabled) return;
  counts.set(event, (counts.get(event) ?? 0) + 1);
}

/** Trace and count in one call, for the events we want both views of. */
export function traceCount(event: string, detail?: () => string): void {
  if (!enabled) return;
  count(event);
  trace(event, detail);
}

/**
 * Write the summary table and close the file. Called from the TUI's exit path
 * so the rates are computed against a known-complete session.
 */
export function stopDebug(): void {
  if (!enabled || !sink) return;
  const secs = since() / 1000;

  const lines = [`\n# summary  elapsed=${secs.toFixed(1)}s`];
  for (const [event, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`# ${event.padEnd(24)} ${String(n).padStart(6)}  ${(n / secs).toFixed(2)}/s`);
  }

  // The summary is the part you actually read, and it is written at the exact
  // moment the process is tearing down — a buffered stream write can lose the
  // race with exit and leave the file ending mid-trace. Appending it
  // synchronously to the same path guarantees it lands.
  sink.end();
  sink = null;
  enabled = false;
  try {
    appendFileSync(path, lines.join("\n") + "\n");
  } catch {
    /* best-effort */
  }
}
