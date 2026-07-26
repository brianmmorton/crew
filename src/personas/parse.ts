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

/** Return the substring of `s` covering the first balanced {...} or [...]. */
function firstBalancedBlock(s: string): string | null {
  let start = -1;
  let open = "";
  let close = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") {
      start = i;
      open = ch;
      close = ch === "{" ? "}" : "]";
      break;
    }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
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
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract a JSON value embedded in a persona's free-form result text. Strips
 * markdown code fences and surrounding prose, then JSON.parses the first
 * balanced `{...}` or `[...]` block. Returns the parsed value, or `null` if
 * nothing parseable is found.
 */
export function extractProposalsJson(resultText: string): unknown {
  // Remove code-fence markers (```json / ```) but keep their contents.
  const defenced = resultText.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");

  const block = firstBalancedBlock(defenced);
  const candidate = block ?? defenced.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
