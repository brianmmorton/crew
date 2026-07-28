import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The verify output that rejected an item's commit, kept so the next cycle can
 * hand it back to the agent.
 *
 * This is stored at a *stable, per-item* path rather than as a run log:
 * `writeRunLog` timestamps its filenames, which is right for an audit trail and
 * useless for lookup on resume. The presence of this file is also the signal
 * that distinguishes a fix-forward worktree (commit exists but was rejected)
 * from a resume worktree (commit exists and passed) — the two look identical to
 * git, and landing the former would push work the gate already refused.
 */

/** Where fix-forward records live (override with CREW_STATE_DIR). */
function dir(configDir: string): string {
  const base = process.env.CREW_STATE_DIR?.trim() || configDir;
  return join(base, "verify-failed");
}

/** Identifiers become filenames, so anything that could escape is replaced. */
function pathFor(configDir: string, identifier: string): string {
  const safe = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dir(configDir), `${safe}.log`);
}

/** Record the failure that rejected this item's commit. Best-effort. */
export function writeVerifyFailure(
  configDir: string,
  identifier: string,
  output: string,
): void {
  try {
    mkdirSync(dir(configDir), { recursive: true });
    writeFileSync(pathFor(configDir, identifier), output || "(no output captured)");
  } catch {
    /* best-effort: losing this costs a fix-forward, not correctness */
  }
}

/**
 * The pending verify failure for an item, or null if it has none. Null is the
 * safe answer on any read error: it means "not a fix-forward", so the cycle
 * treats the worktree normally rather than acting on a half-read record.
 */
export function readVerifyFailure(configDir: string, identifier: string): string | null {
  try {
    const p = pathFor(configDir, identifier);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8") || null;
  } catch {
    return null;
  }
}

/** Drop the record — the commit went green, or the work was discarded. */
export function clearVerifyFailure(configDir: string, identifier: string): void {
  try {
    rmSync(pathFor(configDir, identifier), { force: true });
  } catch {
    /* best effort */
  }
}
