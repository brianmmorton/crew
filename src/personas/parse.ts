/**
 * Pure parsing helpers for headless `claude` output. No side effects, no
 * ambient clock reads — everything here is a deterministic function of input.
 */

export interface ClaudeResult {
  resultText: string;
  isError: boolean;
  sessionId?: string;
}

/**
 * Parse the JSON object that `claude -p --output-format json` prints. Expected
 * shape: `{ result: string, is_error: boolean, session_id: string }`. Defensive:
 * if stdout is not valid JSON (or not an object), return the raw stdout as
 * `resultText` with `isError:false`.
 */
export function parseClaudeStdout(stdout: string): ClaudeResult {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const result =
        typeof obj.result === "string" ? obj.result : stdout;
      const isError = obj.is_error === true;
      const sessionId =
        typeof obj.session_id === "string" ? obj.session_id : undefined;
      return { resultText: result, isError, sessionId };
    }
    return { resultText: stdout, isError: false };
  } catch {
    return { resultText: stdout, isError: false };
  }
}

/**
 * Detect a Claude subscription usage-limit message.
 *
 * Matches phrasings like "hit your session limit", "hit your weekly limit",
 * "usage limit", "rate limit"/"ratelimit". When a reset time is present
 * (e.g. "resets 3:45pm" or "resets Mon 12:00am") the matched time substring
 * is returned as `resetAt`. This function stays pure: it does NOT resolve the
 * time to an absolute ISO instant (that needs `new Date()` — the runner does
 * it); it returns the raw matched time string instead.
 */
export function detectUsageLimit(text: string): {
  limited: boolean;
  resetAt: string | null;
} {
  const limited =
    /hit your (?:session|weekly)?\s*limit/i.test(text) ||
    /usage limit/i.test(text) ||
    /rate.?limit/i.test(text);

  if (!limited) return { limited: false, resetAt: null };

  // Best-effort: capture the substring after "reset(s)". Handles an optional
  // weekday prefix and a HH:MM(am|pm) clock time.
  const m =
    text.match(
      /resets?\s+((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
    ) ?? null;
  const resetAt = m ? m[0].replace(/^resets?\s+/i, "").trim() : null;

  return { limited: true, resetAt };
}

/**
 * Return the balanced {...} or [...] block starting at `from`, or null.
 * `from` must index the opening bracket.
 */
function balancedBlockAt(s: string, from: number): string | null {
  const open = s[from];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(from, i + 1);
    }
  }
  return null;
}

/** Every balanced JSON-ish block in `s`, in order of appearance. */
function balancedBlocks(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "{" && ch !== "[") continue;
    const block = balancedBlockAt(s, i);
    if (block === null) continue;
    out.push(block);
    // Skip past this block; nested objects are part of the payload we captured.
    i += block.length - 1;
  }
  return out;
}

/** The keys a persona payload is recognized by. */
const PAYLOAD_KEYS = ["proposals", "friction", "verdict", "prComment", "issueComment", "transitionTo"];

/** True if a parsed value carries at least one key the engine acts on. */
function looksLikePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return false;
  return PAYLOAD_KEYS.some((k) => k in (value as Record<string, unknown>));
}

/**
 * Extract the JSON payload embedded in a persona's free-form result text.
 *
 * Agents are asked to end with a single fenced JSON block, but they routinely
 * write prose first — and that prose contains code. Taking the *first* bracket
 * in the text is therefore wrong: a sentence mentioning `|| []` or
 * `state?.features` yields an empty `[]`/`{}` that parses fine, so the real
 * payload further down is never seen and the run silently files nothing.
 *
 * The strategy, in order:
 *  1. Fenced ```json blocks, last first — the requested format, and the last
 *     one wins because agents illustrate *examples* earlier in their prose.
 *  2. Any balanced block that actually looks like a payload (`proposals`,
 *     `friction`, or a reviewer verdict key), again last first.
 *  3. As a final fallback, the whole text — for a reply that is bare JSON.
 *
 * Returns the parsed value, or `null` if nothing parseable is found.
 */
export function extractProposalsJson(resultText: string): unknown {
  const candidates: string[] = [];

  // 1. Contents of fenced blocks (```json … ``` or a bare ``` … ```).
  for (const m of resultText.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)) {
    const inner = m[1].trim();
    if (inner) candidates.push(inner);
  }

  // 2. Balanced blocks found in the de-fenced text.
  const defenced = resultText.replace(/```[a-zA-Z]*\r?\n?/g, "").replace(/```/g, "");
  candidates.push(...balancedBlocks(defenced));

  // Prefer a real payload; among equals prefer the LAST, which is the block the
  // agent ended on rather than an example it cited along the way.
  let fallback: unknown = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParse(candidates[i]);
    if (parsed === undefined) continue;
    if (looksLikePayload(parsed)) return parsed;
    // Remember the last parseable non-payload in case nothing better shows up.
    if (fallback === null) fallback = parsed;
  }

  // 3. The whole reply, for output that is bare JSON with no prose or fences.
  const whole = tryParse(defenced.trim());
  if (whole !== undefined && looksLikePayload(whole)) return whole;

  return fallback;
}

/** JSON.parse that reports failure as `undefined` rather than throwing. */
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
