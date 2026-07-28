import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * A reusable pool of git worktrees.
 *
 * The default (one worktree per cycle, created and destroyed) is correct but
 * expensive: on a multi-GB monorepo the checkout alone is minutes, and then
 * `gates.setup` reinstalls dependencies into an empty tree. The pool keeps a
 * fixed set of slots and resets them between cycles instead, so `node_modules`
 * and build caches survive.
 *
 * What that buys is speed; what it costs is coldness. See `resetSlot` for the
 * one operation that has to stay honest for the trade to be safe.
 */

/**
 * `free`     — claimable.
 * `busy`     — an agent is working in it right now.
 * `retained` — holds a verified commit that hasn't landed, or work that needs a
 *              human. Never handed out; see the preserve logic in cycles.ts.
 */
export type SlotState = "free" | "busy" | "retained";

export interface SlotMeta {
  slot: number;
  state: SlotState;
  branch: string | null;
  /** Owning process, so a crashed run's lock can be told from a live one. */
  pid: number | null;
  acquiredAt: string | null;
  /** Resets since the last full clean, driving `recycleAfter`. */
  useCount: number;
  lastDeepClean: string | null;
}

export interface PoolOptions {
  max: number;
  preserveArtifacts: string[];
  recycleAfter: number;
}

/** Thrown when every slot is busy or retained. Callers wait and retry. */
export class PoolExhaustedError extends Error {
  constructor(
    message: string,
    readonly retained: number,
    readonly busy: number,
  ) {
    super(message);
    this.name = "PoolExhaustedError";
  }
}

/**
 * Root of the worktree area for a repo — parent of both pooled slots and the
 * per-branch worktrees used when reuse is off. Defined here so the CLI and the
 * git adapter can't drift on where worktrees live.
 */
export function worktreeRootFor(repoPath: string): string {
  const repoName = basename(repoPath) || "repo";
  return join(dirname(repoPath), `.crew-worktrees-${repoName}`);
}

function metaPath(dir: string, slot: number): string {
  return join(dir, `slot-${slot}.json`);
}

function lockPath(dir: string, slot: number): string {
  return join(dir, `slot-${slot}.lock`);
}

export function slotPath(dir: string, slot: number): string {
  return join(dir, `slot-${slot}`);
}

function defaultMeta(slot: number): SlotMeta {
  return {
    slot,
    state: "free",
    branch: null,
    pid: null,
    acquiredAt: null,
    useCount: 0,
    lastDeepClean: null,
  };
}

export function readMeta(dir: string, slot: number): SlotMeta {
  try {
    const raw = JSON.parse(readFileSync(metaPath(dir, slot), "utf8")) as Partial<SlotMeta>;
    return { ...defaultMeta(slot), ...raw, slot };
  } catch {
    // Missing or corrupt metadata means "never used" — the directory itself is
    // the source of truth for whether a checkout exists.
    return defaultMeta(slot);
  }
}

export function writeMeta(dir: string, meta: SlotMeta): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaPath(dir, meta.slot), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Is `pid` still running? Used to tell a crashed owner's lock from a live one.
 * Signal 0 performs the permission/existence check without delivering anything.
 *
 * EPERM means the process exists but belongs to another user, which still
 * counts as alive — reclaiming it would hand out a slot someone else is in.
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
 * Take the lock for one slot, or return false if someone else holds it.
 *
 * `wx` is the whole point: create-if-absent is a single atomic syscall, so two
 * processes racing for the same slot cannot both win. A read-then-write check
 * would look correct and fail under `implementerWorkers > 1`.
 */
export function tryLock(dir: string, slot: number): boolean {
  mkdirSync(dir, { recursive: true });
  const path = lockPath(dir, slot);
  try {
    const fd = openSync(path, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  // The lock exists. It is only reclaimable if its owner is gone — a live owner
  // means the slot is genuinely in use, and a retained slot is off-limits even
  // if its owner died, because it holds work nobody has landed yet.
  let owner = 0;
  try {
    owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    owner = 0;
  }
  // Deliberately no same-pid shortcut: workers share a process, so our own pid
  // on a lock means a sibling worker holds it, not that it is free.
  if (pidAlive(owner)) return false;
  if (readMeta(dir, slot).state === "retained") return false;

  try {
    rmSync(path, { force: true });
    const fd = openSync(path, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    // Another process reclaimed it first — that's a normal race, not an error.
    return false;
  }
}

export function unlock(dir: string, slot: number): void {
  try {
    rmSync(lockPath(dir, slot), { force: true });
  } catch {
    /* best effort */
  }
}

/** Every slot's metadata, for status output and diagnostics. */
export function poolStatus(dir: string, max: number): SlotMeta[] {
  return Array.from({ length: max }, (_, i) => readMeta(dir, i));
}

/**
 * Untracked paths to delete, given `git status --porcelain` output.
 *
 * Exported for tests because this predicate is the safety boundary of the whole
 * feature: too eager and it deletes the caches that make pooling worthwhile,
 * too lax and one cycle's leftovers satisfy the next cycle's verify.
 */
export function untrackedToRemove(porcelain: string, preserve: string[]): string[] {
  const out: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    let path = line.slice(3).trim();
    // Paths with spaces or non-ASCII come back quoted and C-escaped.
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (!path) continue;
    const segments = path.replace(/\/$/, "").split("/");
    // Match on any segment, not just the first: a monorepo's caches live at
    // packages/*/node_modules, not only at the root.
    if (segments.some((s) => preserve.includes(s))) continue;
    out.push(path);
  }
  return out;
}

/**
 * Does this reset need a full clean rather than the fast path?
 * `recycleAfter: 0` disables deep cleans entirely.
 */
export function needsDeepClean(meta: SlotMeta, recycleAfter: number): boolean {
  if (recycleAfter <= 0) return false;
  return meta.useCount >= recycleAfter;
}

/**
 * Pick a claimable slot and lock it, or throw `PoolExhaustedError`.
 *
 * Retained slots count against `max`. That keeps the disk bound honest — the
 * reason to cap the pool at all is that each slot is a full GB-scale checkout —
 * but it means a run whose pushes keep failing can starve itself, so the error
 * distinguishes "busy" from "retained": only one of those clears on its own.
 */
export function acquireSlot(dir: string, opts: PoolOptions, branch: string): SlotMeta {
  mkdirSync(dir, { recursive: true });

  let retained = 0;
  let busy = 0;
  for (let i = 0; i < opts.max; i++) {
    const meta = readMeta(dir, i);
    if (meta.state === "retained") {
      retained++;
      continue;
    }
    // A busy slot with a live owner is in use — including when that owner is
    // THIS process. Several workers run in one supervisor process, so treating
    // "same pid" as reclaimable would hand one worktree to two concurrent
    // agents and let them overwrite each other's work.
    if (meta.state === "busy" && pidAlive(meta.pid ?? 0)) {
      busy++;
      continue;
    }
    if (!tryLock(dir, i)) {
      busy++;
      continue;
    }
    // Re-read under the lock: state may have changed between the scan above and
    // the lock being taken.
    const fresh = readMeta(dir, i);
    if (fresh.state === "retained") {
      unlock(dir, i);
      retained++;
      continue;
    }
    const claimed: SlotMeta = {
      ...fresh,
      state: "busy",
      branch,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    writeMeta(dir, claimed);
    return claimed;
  }

  throw new PoolExhaustedError(
    `no free worktree slot (max=${opts.max}, busy=${busy}, retained=${retained})`,
    retained,
    busy,
  );
}

/** Return a slot to the pool. `retain` keeps it out of circulation. */
export function releaseSlot(dir: string, slot: number, retain: boolean): void {
  const meta = readMeta(dir, slot);
  writeMeta(dir, {
    ...meta,
    state: retain ? "retained" : "free",
    pid: retain ? meta.pid : null,
    branch: retain ? meta.branch : null,
    acquiredAt: retain ? meta.acquiredAt : null,
  });
  // A retained slot keeps its metadata but not its lock: the holding process
  // exits, and the state field alone is what keeps it out of the free list.
  unlock(dir, slot);
}

/** Find the slot currently holding `branch`, or null. Drives resume. */
export function findSlotForBranch(dir: string, max: number, branch: string): SlotMeta | null {
  for (let i = 0; i < max; i++) {
    const meta = readMeta(dir, i);
    if (meta.branch === branch && meta.state !== "free") return meta;
  }
  return null;
}

/** Drop a slot's checkout and metadata entirely, so the next use is cold. */
export function destroySlot(dir: string, slot: number): void {
  for (const p of [slotPath(dir, slot), metaPath(dir, slot), lockPath(dir, slot)]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Slot directories present on disk, including ones above the current `max`. */
export function existingSlots(dir: string): number[] {
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const entry of readdirSync(dir)) {
    const m = /^slot-(\d+)$/.exec(entry);
    if (m) out.push(Number.parseInt(m[1], 10));
  }
  return out.sort((a, b) => a - b);
}
