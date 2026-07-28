import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

/**
 * A per-ticket claim lock.
 *
 * `selectNextExecutable()` is a read-then-write: two workers can both see the
 * same item and both transition it, and neither learns it lost — the tracker
 * has no compare-and-set to arbitrate with. This does the arbitrating locally.
 *
 * Deliberately the same design as the worktree pool's slot lock (see
 * `git/pool.ts`): create-if-absent is a single atomic syscall, so a race has
 * exactly one winner. One concurrency model for the whole engine, not two.
 *
 * Scope: this coordinates workers that share a filesystem. Two crew instances
 * on different machines pointed at one tracker can still double-claim.
 */

/** Who holds a claim, and since when. */
export interface Claim {
  identifier: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

/** Claims live beside the rest of crew's state, under <configDir>/claims. */
export function claimDir(configDir: string): string {
  const dir = process.env.CREW_STATE_DIR?.trim() || configDir;
  return join(dir, "claims");
}

/**
 * Ticket identifiers become filenames, so anything that could escape the
 * directory or collide across distinct ids is replaced. Linear/Jira keys are
 * already `ABC-123`, so this is a guard against a malformed id, not routine.
 */
function claimFile(configDir: string, identifier: string): string {
  const safe = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(claimDir(configDir), `${safe}.json`);
}

function readClaim(path: string): Claim | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Claim>;
    if (!raw.identifier || typeof raw.pid !== "number") return null;
    return {
      identifier: raw.identifier,
      pid: raw.pid,
      host: raw.host ?? "",
      acquiredAt: raw.acquiredAt ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Is `pid` still running? Signal 0 does the existence/permission check without
 * delivering anything. EPERM means it exists under another user — still alive,
 * and reclaiming it would hand one ticket to two workers.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A claim written by a process on another host can't be liveness-checked —
 * `pidAlive` would be answering about a local pid that happens to share the
 * number. Those are treated as held, so a foreign claim is never stolen.
 */
function reclaimable(claim: Claim | null): boolean {
  if (!claim) return true; // unreadable/corrupt: no owner to protect
  if (claim.host && claim.host !== hostname()) return false;
  return !pidAlive(claim.pid);
}

/** This machine's identity, overridable so tests can simulate a second host. */
function hostname(): string {
  const override = process.env.CREW_HOST_ID?.trim();
  if (override) return override;
  try {
    return osHostname();
  } catch {
    return "";
  }
}

/**
 * Take the claim for `identifier`, or return false if another live worker holds
 * it. A claim whose owner has died is reclaimed: that is exactly the crashed-
 * mid-run case, and leaving it locked would strand the ticket forever.
 */
export function acquireClaim(configDir: string, identifier: string): boolean {
  const dir = claimDir(configDir);
  mkdirSync(dir, { recursive: true });
  const path = claimFile(configDir, identifier);
  const mine: Claim = {
    identifier,
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  try {
    const fd = openSync(path, "wx");
    writeFileSync(fd, `${JSON.stringify(mine, null, 2)}\n`);
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  // Someone holds it. Deliberately no same-pid shortcut: several workers share
  // one supervisor process, so our own pid on a claim means a sibling worker
  // has this ticket — not that it is ours to take.
  if (!reclaimable(readClaim(path))) return false;

  try {
    rmSync(path, { force: true });
    const fd = openSync(path, "wx");
    writeFileSync(fd, `${JSON.stringify(mine, null, 2)}\n`);
    closeSync(fd);
    return true;
  } catch {
    // Another worker reclaimed it first — a normal race, not an error.
    return false;
  }
}

/** Drop a claim. Safe to call when it was never held. */
export function releaseClaim(configDir: string, identifier: string): void {
  try {
    rmSync(claimFile(configDir, identifier), { force: true });
  } catch {
    /* best effort */
  }
}

/** Every claim currently on disk, for status output and diagnostics. */
export function listClaims(configDir: string): Claim[] {
  const dir = claimDir(configDir);
  if (!existsSync(dir)) return [];
  const out: Claim[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const claim = readClaim(join(dir, entry));
    if (claim) out.push(claim);
  }
  return out.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

/** Claims whose owner is gone — stranded work, and what recovery looks for. */
export function staleClaims(configDir: string): Claim[] {
  return listClaims(configDir).filter((c) => reclaimable(c));
}
