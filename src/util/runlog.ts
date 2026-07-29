import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The audit trail for agent runs, in two parts:
 *
 * - `<configDir>/logs/runs/<timestamp>-<label>.log` — one file per run, holding
 *   its full raw output. Unchanged from when this module only did that.
 * - `<configDir>/logs/runs.jsonl` — one append-only line per run, holding the
 *   structured facts a filename can't carry (outcome, item title, PR url,
 *   duration). This is what the TUI's history sidebar reads.
 *
 * JSONL rather than a JSON blob: an append can't clobber a concurrent writer
 * the way a read-modify-write file can (see util/state.ts for what defending
 * against that costs), reading the last N lines is cheap, and the file stays
 * greppable.
 */

/** The stage of a cycle a run belongs to. */
export type RunKind = "propose" | "implement" | "verify" | "review";

/** How a run ended. */
export type RunOutcome = "ok" | "failed" | "usage-limited" | "rejected";

/** One line of runs.jsonl. Everything but `id`/`kind`/`at` is optional. */
export interface RunRecord {
  /** The log file's basename — the stable join key to the raw output. */
  id: string;
  kind: RunKind;
  /** ISO timestamp the run finished. */
  at: string;
  /** Which agent ran, when a single agent owns the run. */
  agent?: string;
  /** Tracker identifier (ENG-123) — the key sessions are grouped by. */
  item?: string;
  /** Tracker title, so the sidebar can show something human-readable. */
  title?: string;
  outcome?: RunOutcome;
  /** Wall-clock milliseconds, when the caller measured it. */
  ms?: number;
  model?: string;
  prUrl?: string;
  /**
   * Tracker identifiers this run filed (proposers, and reviewers that file
   * follow-ups). The point of the history pane is "what did this produce",
   * and for a proposer the answer is exactly this list.
   */
  created?: string[];
  /**
   * Why a run failed, already trimmed to something a narrow pane can show:
   * the verify output tail, the gate violation, or the error message. Never
   * the whole transcript — that's what `logPath` is for.
   */
  reason?: string;
  /** Absolute path to the raw output file, or null if that write failed. */
  logPath?: string | null;
  /**
   * Marks a follow-up line that PATCHES an earlier run (see `amendRun`) rather
   * than describing a new one. Explicit rather than inferred from a repeated
   * id: ids are only unique in practice, and silently merging two distinct
   * runs that happened to collide would lose one of them outright.
   */
  amend?: boolean;
}

/**
 * Max length of a persisted `reason`. Wide enough for a verify tail worth
 * reading, short enough that the index stays cheap to parse.
 */
export const MAX_REASON = 600;

/** Trim a failure reason to the last `MAX_REASON` chars, keeping the tail. */
export function trimReason(s: string, n = MAX_REASON): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** Metadata a caller supplies; `id`/`at`/`logPath` are filled in here. */
export type RunMetaInput = Omit<RunRecord, "id" | "at" | "logPath">;

/** `<configDir>/logs/runs.jsonl`. */
export function runIndexPath(configDir: string): string {
  return join(configDir, "logs", "runs.jsonl");
}

/**
 * Persist one run: full output to its own file, structured line to the index.
 * Returns the log path (or null), so callers that log "full run output → …"
 * read exactly as they did when this was `writeRunLog`.
 *
 * Best-effort by design — an audit-trail write must never fail a cycle that
 * otherwise succeeded.
 */
export function recordRun(
  configDir: string,
  label: string,
  content: string,
  meta: RunMetaInput,
): string | null {
  const path = writeRunLog(configDir, label, content);
  appendRunIndex(configDir, {
    ...meta,
    id: path ? basename(path) : sanitize(label),
    at: new Date().toISOString(),
    logPath: path,
  });
  return path;
}

/**
 * Persist one agent run's full output to its own file under
 * <configDir>/logs/runs/<timestamp>-<label>.log, so you can inspect exactly what
 * a given QA/Design/Architect/Implementer run produced. Returns the path (or null).
 */
export function writeRunLog(configDir: string, label: string, content: string): string | null {
  try {
    const dir = join(configDir, "logs", "runs");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${ts}-${sanitize(label)}.log`);
    writeFileSync(path, content || "(no output captured)");
    return path;
  } catch {
    return null;
  }
}

/**
 * Append a follow-up line for a run whose outcome is only known later — a
 * proposer's filed tickets, say, which don't exist until after the run's
 * output has been written.
 *
 * An append rather than an in-place edit: rewriting a line would reintroduce
 * exactly the read-modify-write race this format exists to avoid. The reader
 * merges same-id records (see util/runindex), so two lines describing one run
 * collapse back into one entry.
 */
export function amendRun(configDir: string, id: string, patch: Partial<RunRecord>): void {
  if (!id) return;
  appendRunIndex(configDir, {
    kind: "propose",
    ...patch,
    id,
    at: new Date().toISOString(),
    amend: true,
  });
}

/** Append one record to the index. Exported for tests; prefer `recordRun`. */
export function appendRunIndex(configDir: string, record: RunRecord): void {
  try {
    mkdirSync(join(configDir, "logs"), { recursive: true });
    appendFileSync(runIndexPath(configDir), `${JSON.stringify(record)}\n`);
  } catch {
    /* best-effort — never fail a cycle over the audit trail */
  }
}

/**
 * Default number of run logs kept on disk. Each is a full agent transcript,
 * so an uncapped directory is how `logs/runs` reaches a gigabyte.
 */
export const DEFAULT_RETAIN_RUNS = 500;

/**
 * Exactly the filenames `writeRunLog` produces:
 * `<ISO-with-dashes>-<sanitized-label>.log`. Pruning matches against this and
 * nothing else — a stray file a human parked in the directory is never a
 * deletion candidate.
 */
const RUN_LOG_NAME = /^\d{4}-\d\d-\d\d(?:T|-)[\dT_-]*-.*\.log$/;

/**
 * Delete all but the newest `keep` run logs. Names sort lexicographically by
 * time (ISO timestamps with `:`/`.` swapped for `-`), so sorting the names IS
 * sorting by age — no stat() per file.
 *
 * Only prunes the `.log` files. The JSONL index is bounded on the READ side
 * (see util/runindex), so trimming it here would delete history the sidebar
 * can still cheaply show.
 */
export function pruneRunLogs(configDir: string, keep = DEFAULT_RETAIN_RUNS): number {
  if (keep < 0) return 0;
  const dir = join(configDir, "logs", "runs");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => RUN_LOG_NAME.test(n));
  } catch {
    return 0; // no directory yet, or unreadable — nothing to prune
  }
  if (names.length <= keep) return 0;

  const doomed = names.sort().slice(0, names.length - keep);
  let removed = 0;
  for (const name of doomed) {
    try {
      rmSync(join(dir, name));
      removed++;
    } catch {
      /* a file we couldn't remove is not worth failing over */
    }
  }
  return removed;
}

function sanitize(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, "_");
}
