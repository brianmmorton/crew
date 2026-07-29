import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { RunKind, RunOutcome, RunRecord } from "./runlog.js";
import { runIndexPath } from "./runlog.js";

/**
 * Reading side of `logs/runs.jsonl` (written by util/runlog). Split from the
 * writer so the TUI never imports an engine write path.
 *
 * Reads are BOUNDED: only the last `maxBytes` of the file are parsed, from the
 * end. The history sidebar shows a few dozen sessions, so parsing a
 * months-old index in full every poll would be pure waste.
 */

/** How much of the index tail to parse. ~700B/record → roughly 350 records. */
const DEFAULT_MAX_BYTES = 256_000;

/** A group of runs that share a tracker item — one unit of work. */
export interface Session {
  /** Tracker identifier, or the run id for runs that have no item. */
  key: string;
  /** Display label: the item identifier, or the agent name for proposals. */
  label: string;
  title?: string;
  /** Every run in the session, oldest first. */
  runs: RunRecord[];
  /** Epoch ms of the most recent run — what the list sorts by. */
  at: number;
  /** Rolled-up outcome across the session (see `rollUp`). */
  outcome: RunOutcome;
  /** Distinct agents that took part, in first-seen order. */
  agents: string[];
  /** The PR this session produced, if any run recorded one. */
  prUrl?: string;
  /** Summed wall-clock of every run that measured itself. */
  ms: number;
  /** Tracker identifiers filed by this session, deduped. */
  created: string[];
  /** Why it failed — the newest reason recorded, already trimmed. */
  reason?: string;
  /** Which stage produced `reason`, for labelling it in the UI. */
  reasonKind?: RunKind;
}

/**
 * One line of "what this run produced", for the compact history pane. Exactly
 * the four things worth knowing at a glance: a PR, filed tickets, a failure
 * reason, or (failing all of that) what ran.
 */
export interface Highlight {
  kind: "pr" | "created" | "error" | "info";
  text: string;
}

/**
 * The compact summary shown under a session. Ordered by what a user scanning
 * for trouble needs first: the failure, then what was produced.
 */
export function highlights(s: Session): Highlight[] {
  const out: Highlight[] = [];
  if (s.reason) {
    out.push({ kind: "error", text: `${reasonLabel(s)}: ${firstLine(s.reason)}` });
  }
  if (s.prUrl) out.push({ kind: "pr", text: s.prUrl });
  if (s.created.length) {
    out.push({ kind: "created", text: `filed ${s.created.join(", ")}` });
  }
  if (!out.length) {
    const stages = [...new Set(s.runs.map((r) => r.kind))].join(" → ");
    out.push({ kind: "info", text: stages || "ran" });
  }
  return out;
}

/**
 * What to call the failure. The OUTCOME distinguishes a gate that refused the
 * work ("rejected") from one that broke ("verify"/"error") — labelling a
 * protected-path rejection as an error misreads what happened.
 */
function reasonLabel(s: Session): string {
  if (s.outcome === "rejected") return "rejected";
  if (s.outcome === "usage-limited") return "usage";
  return s.reasonKind === "verify" ? "verify" : "error";
}

/**
 * The most useful single line of a failure. Verify output ends in a summary
 * ("2 failed, 41 passed"), but the LAST line is often blank or a stray prompt,
 * so this takes the last line with real content.
 */
function firstLine(reason: string): string {
  const lines = reason
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? reason.trim();
  // `String(e)` yields "Error: …", which would render as "error: Error: …".
  return last.replace(/^(?:Error|TypeError|RangeError):\s*/, "");
}

/**
 * Parse the tail of the index, oldest record first. Malformed lines are
 * skipped rather than throwing — a torn write during a crash must not make the
 * whole history unreadable.
 */
export function readRunIndex(configDir: string, maxBytes = DEFAULT_MAX_BYTES): RunRecord[] {
  const path = runIndexPath(configDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    const st = statSync(path);
    const start = Math.max(0, st.size - maxBytes);
    const length = st.size - start;
    if (length === 0) return [];
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      raw = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    // A mid-file start almost certainly lands inside a record; drop the
    // partial head so it can't parse as a bogus entry.
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
  } catch {
    return [];
  }

  const out: RunRecord[] = [];
  /** id -> index in `out`, so an amendment merges into the original entry. */
  const seen = new Map<string, number>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: RunRecord;
    try {
      rec = JSON.parse(line) as RunRecord;
    } catch {
      continue; // torn/garbage line
    }
    if (!rec || typeof rec.id !== "string" || typeof rec.at !== "string") continue;

    // An explicitly-flagged amendment patches the run it names (see
    // runlog.amendRun) rather than describing a new one. `at` is kept from the
    // ORIGINAL so a late amendment doesn't jump the entry to the top of the
    // list. An amendment for a run we never saw — its original scrolled out of
    // the bounded tail — is dropped rather than shown as a bare fragment.
    const prior = seen.get(rec.id);
    if (rec.amend) {
      if (prior === undefined) continue;
      const { amend: _drop, ...patch } = rec;
      out[prior] = { ...out[prior]!, ...stripUndefined(patch as RunRecord), at: out[prior]!.at };
      continue;
    }
    seen.set(rec.id, out.length);
    out.push(rec);
  }
  return out;
}

/** Drop undefined values so a patch can't blank a field the original set. */
function stripUndefined(rec: RunRecord): Partial<RunRecord> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (v !== undefined) out[k] = v;
  return out as Partial<RunRecord>;
}

/**
 * Group runs into sessions by tracker item, newest session first.
 *
 * Runs without an item (proposer runs) can't be grouped — each is its own
 * session, keyed by run id. Grouping them by agent would collapse every
 * proposal that agent ever made into one row.
 */
export function toSessions(records: RunRecord[]): Session[] {
  const byKey = new Map<string, Session>();
  for (const rec of records) {
    const key = rec.item ?? rec.id;
    const at = Date.parse(rec.at) || 0;
    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        label: rec.item ?? rec.agent ?? rec.kind,
        title: rec.title,
        runs: [],
        at,
        outcome: "ok",
        agents: [],
        ms: 0,
        created: [],
      };
      byKey.set(key, s);
    }
    s.runs.push(rec);
    s.at = Math.max(s.at, at);
    s.title ??= rec.title;
    s.prUrl ??= rec.prUrl;
    s.ms += rec.ms ?? 0;
    if (rec.agent && !s.agents.includes(rec.agent)) s.agents.push(rec.agent);
    for (const id of rec.created ?? []) if (!s.created.includes(id)) s.created.push(id);
    // Newest reason wins: a later failure describes the current state better
    // than the one that preceded a retry.
    if (rec.reason) {
      s.reason = rec.reason;
      s.reasonKind = rec.kind;
    }
  }

  const sessions = [...byKey.values()];
  for (const s of sessions) {
    s.runs.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    s.outcome = rollUp(s.runs);
    // Recomputed from the SORTED runs: the index is in file order, which is
    // usually chronological but isn't guaranteed to be after an amendment.
    const lastFailure = [...s.runs].reverse().find((r) => r.reason);
    s.reason = lastFailure?.reason;
    s.reasonKind = lastFailure?.kind;
  }
  return sessions.sort((a, b) => b.at - a.at);
}

/**
 * One outcome for a whole session. Worst-wins, deliberately: a session whose
 * verify failed and was then retried green still deserves to read as
 * "something went wrong here" when you're scanning the list for trouble.
 */
function rollUp(runs: RunRecord[]): RunOutcome {
  const rank: Record<RunOutcome, number> = {
    ok: 0,
    "usage-limited": 1,
    rejected: 2,
    failed: 3,
  };
  let worst: RunOutcome = "ok";
  for (const r of runs) {
    const o = r.outcome ?? "ok";
    if (rank[o] > rank[worst]) worst = o;
  }
  return worst;
}

/** Read + group in one call — what the TUI poller uses. */
export function readSessions(configDir: string, maxBytes?: number): Session[] {
  return toSessions(readRunIndex(configDir, maxBytes));
}

export type { RunRecord, RunKind, RunOutcome };
