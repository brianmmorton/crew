import type { CrewConfig } from "../types.js";
import { listClaims, staleClaims, type Claim } from "./claim.js";
import { readVerifyFailure } from "../util/verifyfail.js";
import { resumeAttempts, verifyAttempts } from "../util/state.js";

/**
 * What the engine knows about work that stopped somewhere other than a PR.
 *
 * This exists because the failure states are otherwise invisible: an item whose
 * cycle died leaves a claim nobody will release, and a preserved worktree holds
 * a pool slot until someone notices. Both used to be findable only by reading
 * scrollback. `crew status` and `crew worktrees` render this.
 */

export interface StuckItem {
  identifier: string;
  /**
   * `abandoned` — a claim whose owning process is gone; the cycle died and
   *               nothing will retry it until the item is selected again.
   * `fixing`    — verification rejected the commit; the agent gets another go.
   * `working`   — a live worker holds it right now. Not a problem, shown so the
   *               list accounts for every claim rather than implying the rest
   *               are stuck.
   */
  state: "abandoned" | "fixing" | "working";
  claim: Claim | null;
  /** Attempts spent, when the item is in a retry loop. */
  verifyTries: number;
  landTries: number;
  /** First line of the verify failure, as a hint at what broke. */
  reason: string | null;
}

/** First non-empty line, trimmed to something that fits one terminal row. */
function firstLine(output: string | null): string | null {
  if (!output) return null;
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/**
 * Every item the engine is holding state for, newest concern first: abandoned
 * claims, then pending fixes, then live work.
 *
 * Claims are the index rather than the verify-failure records, because an
 * abandoned claim is the more urgent signal — a fix record with no claim is
 * simply an item waiting to be picked up again, which is working as intended.
 */
export function stuckItems(cfg: CrewConfig): StuckItem[] {
  const stale = new Set(staleClaims(cfg.configDir).map((c) => c.identifier));
  const out: StuckItem[] = [];

  for (const claim of listClaims(cfg.configDir)) {
    const id = claim.identifier;
    const failure = readVerifyFailure(cfg.configDir, id);
    out.push({
      identifier: id,
      state: stale.has(id) ? "abandoned" : failure ? "fixing" : "working",
      claim,
      verifyTries: verifyAttempts(cfg.configDir, id),
      landTries: resumeAttempts(cfg.configDir, id),
      reason: firstLine(failure),
    });
  }

  const rank = { abandoned: 0, fixing: 1, working: 2 };
  return out.sort(
    (a, b) => rank[a.state] - rank[b.state] || a.identifier.localeCompare(b.identifier),
  );
}

/** One line per item, for `crew status` and `crew worktrees`. */
export function formatStuck(items: StuckItem[]): string[] {
  return items.map((i) => {
    const tries = [
      i.verifyTries ? `verify ${i.verifyTries}` : "",
      i.landTries ? `land ${i.landTries}` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const parts = [
      `  ${i.identifier.padEnd(10)} ${i.state.padEnd(9)}`,
      tries ? ` (${tries})` : "",
      i.reason ? `  ${i.reason}` : "",
    ];
    return parts.join("");
  });
}
