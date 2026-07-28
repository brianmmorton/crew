import { execFile } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CheckoutSnapshot, ForgePort, GitPort, OpenPrOptions } from "../types.js";
import { matchesAny } from "../util/glob.js";
import { GitHubForge } from "./forge/github.js";
import {
  acquireSlot,
  destroySlot,
  findSlotForBranch,
  needsDeepClean,
  type PoolOptions,
  readMeta,
  releaseSlot,
  slotPath,
  untrackedToRemove,
  worktreeRootFor,
  writeMeta,
} from "./pool.js";

const pExecFile = promisify(execFile);

/** Turn a branch name into a filesystem-safe directory segment. */
function sanitizeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Plain git operations (worktrees, diffs, push) plus pull requests delegated to
 * a `ForgePort`. Everything above this layer sees one `GitPort` and never has
 * to know which code host is behind it.
 */
export class GitAdapter implements GitPort {
  private readonly forge: ForgePort;
  /**
   * Set only when worktree reuse is enabled. Unset means every cycle gets a
   * fresh checkout — the original behaviour, and what the cold-verify probe
   * always wants regardless of how the engine is configured.
   */
  private readonly pool?: PoolOptions;

  constructor(
    private readonly repoPath: string,
    private readonly baseBranch: string,
    /** Defaults to GitHub so existing callers keep their behaviour. */
    forge?: ForgePort,
    pool?: PoolOptions,
  ) {
    this.forge = forge ?? new GitHubForge(repoPath);
    this.pool = pool;
  }

  /** Root of the worktree area — the parent of both pooled and per-branch trees. */
  private worktreeRoot(): string {
    return worktreeRootFor(this.repoPath);
  }

  /**
   * Run `git` with an explicit argv array (never a shell string) so that
   * branch names / paths can't be interpreted by a shell. Returns trimmed
   * stdout; throws with stderr on a non-zero exit.
   */
  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await pExecFile("git", args, {
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr || e.message || "").toString().trim();
      throw new Error(`git ${args.join(" ")} failed: ${detail}`);
    }
  }

  /**
   * Where a branch's worktree lives: a sibling of the repo, never inside it.
   *
   * It used to sit at `<repo>/.git/crew-worktrees/`. Git itself is fine with
   * that, but everything else is not — a working tree inside `.git` is invisible
   * to git's own ignore rules yet perfectly visible to any tool that walks the
   * filesystem. A pnpm/npm/yarn workspace glob like `packages: ["**"]` descends
   * into it and treats the worktree as a phantom workspace member of the main
   * repo, so installs and lockfile updates in the worktree corrupt the parent
   * checkout. Editors, watchers, and search tools hit the same trap.
   *
   * Outside the repo, none of that can happen: the worktree is simply not part
   * of any tree the main checkout's tooling walks.
   */
  private worktreePath(branch: string): string {
    return join(this.worktreeRoot(), sanitizeBranch(branch));
  }

  /**
   * Reset a pooled slot to `origin/<base>` on a new branch, keeping the build
   * artifacts that make reuse worth doing.
   *
   * The obvious implementation — `git clean -xdff` — is the wrong primitive at
   * the scale this feature exists for. `clean` stats the entire working tree to
   * find untracked files, so on a multi-GB monorepo it costs minutes whether or
   * not anything needs deleting, and `-e node_modules` stops the deletion but
   * not the walk. That would leave "reuse" barely faster than a cold checkout.
   *
   * Instead: `reset --hard` (proportional to the diff) plus explicit removal of
   * the untracked paths `status` reports (proportional to the mess). Both track
   * the previous agent's footprint rather than the repo's size, which is what
   * makes pooling viable here at all.
   */
  private async resetSlot(wt: string, branch: string, deep: boolean): Promise<void> {
    await this.git(["-C", wt, "checkout", "-B", branch, `origin/${this.baseBranch}`, "--no-track"]);
    await this.git(["-C", wt, "reset", "--hard", `origin/${this.baseBranch}`]);

    if (deep) {
      // The periodic honesty check: drop everything untracked, artifacts too.
      await this.git(["-C", wt, "clean", "-xdff"]);
      return;
    }

    const porcelain = await this.git(["-C", wt, "status", "--porcelain", "--untracked-files=normal"]);
    for (const rel of untrackedToRemove(porcelain, this.pool?.preserveArtifacts ?? [])) {
      try {
        rmSync(join(wt, rel), { recursive: true, force: true });
      } catch {
        /* best effort — a leftover file is not worth failing the cycle over */
      }
    }
  }

  /**
   * Claim a pooled slot for `branch`, creating its checkout if this slot has
   * never been used. Throws `PoolExhaustedError` when nothing is claimable.
   */
  private async acquirePooled(branch: string): Promise<string> {
    const dir = this.worktreeRoot();
    const opts = this.pool!;
    // Before claiming a slot: this branch name can never be created, so taking
    // one would burn a slot and then fail anyway.
    const blocker = await this.blockingBranch(branch);
    if (blocker) throw this.blockedError(branch, blocker);
    const meta = acquireSlot(dir, opts, branch);
    const wt = slotPath(dir, meta.slot);
    const started = Date.now();
    let how = "reset";

    try {
      const tracked = await this.isTrackedWorktree(wt);
      if (!tracked) {
        how = "cold checkout";
        // First use of this slot, or its checkout was removed underneath us.
        destroySlot(dir, meta.slot);
        writeMeta(dir, { ...meta, useCount: 0, lastDeepClean: null });
        await this.git(["-C", this.repoPath, "worktree", "prune"]).catch(() => {});
        await this.git(["-C", this.repoPath, "branch", "-D", branch]).catch(() => {});
        await this.git([
          "-C",
          this.repoPath,
          "worktree",
          "add",
          "-b",
          branch,
          wt,
          `origin/${this.baseBranch}`,
        ]);
      } else {
        // Count this reset before deciding: useCount is "resets since the last
        // deep clean", so recycleAfter:1 must deep-clean on the very first reuse
        // rather than one cycle later.
        const uses = meta.useCount + 1;
        const deep = needsDeepClean({ ...meta, useCount: uses }, opts.recycleAfter);
        how = deep ? "deep clean" : "reset";
        // The branch is being recreated, so a leftover of the same name from a
        // prior cycle has to go or `checkout -B` fights with it.
        await this.git(["-C", this.repoPath, "branch", "-D", branch]).catch(() => {});
        await this.resetSlot(wt, branch, deep);
        writeMeta(dir, {
          ...readMeta(dir, meta.slot),
          useCount: deep ? 0 : uses,
          lastDeepClean: deep ? new Date().toISOString() : meta.lastDeepClean,
        });
      }
    } catch (e) {
      // A half-reset slot is more dangerous than a slow one: it would hand an
      // agent a tree with the previous cycle's edits still in it. Destroy it and
      // let the slot start cold next time rather than salvaging.
      destroySlot(dir, meta.slot);
      releaseSlot(dir, meta.slot, false);
      throw e;
    }

    try {
      await this.git(["-C", wt, "config", "core.hooksPath", ".githooks"]);
    } catch {
      // ignore — hooks are optional
    }
    // Surfacing which path ran and what it cost is how you tell whether
    // preserveArtifacts is tuned: a "reset" as slow as a cold checkout means
    // the artifacts you care about aren't actually being kept.
    this.onPoolEvent?.({ slot: meta.slot, how, ms: Date.now() - started, path: wt });
    return wt;
  }

  /** Observer for pool acquisitions, so the engine can log timings. */
  onPoolEvent?: (e: { slot: number; how: string; ms: number; path: string }) => void;

  /**
   * Is `path` a directory git currently tracks as a worktree of this repo,
   * AND does its own `.git` file actually resolve there?
   *
   * The two can disagree: the primary repo's `worktree list` is a registry
   * entry, but the slot's `.git` is a separate file living inside the slot
   * itself. If that file is missing, empty, or points somewhere stale — a
   * half-finished reset, a disk hiccup, an agent that ran a destructive git
   * command in its own tree — the registry can still list the slot as valid
   * while ordinary git commands inside it fail with "not a git repository".
   * The fast (reset) path in `acquirePooled` never re-checks that once this
   * returns true, so a slot in that state would be handed to the next agent
   * as-is: it would fail to commit, and any work would land wherever the
   * agent's tooling fell back to instead — outside the worktree.
   */
  private async isTrackedWorktree(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    try {
      const list = await this.git(["-C", this.repoPath, "worktree", "list", "--porcelain"]);
      const want = realpathSync(path);
      const registered = list
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim())
        .some((p) => {
          try {
            return realpathSync(p) === want;
          } catch {
            return false;
          }
        });
      if (!registered) return false;

      // Confirm the slot's own .git resolves into THIS repo's worktree
      // metadata, not just that the repo's registry mentions the path.
      // `--git-dir` is absolute on modern git but relative on older versions;
      // `resolve` (unlike `join`) handles both by discarding `path` when
      // `gitDir` is already absolute.
      const gitDir = await this.git(["-C", path, "rev-parse", "--git-dir"]);
      const resolvedGitDir = realpathSync(resolve(path, gitDir));
      const resolvedMainGitDir = realpathSync(join(this.repoPath, ".git"));
      return (
        resolvedGitDir.startsWith(`${resolvedMainGitDir}${sep}worktrees${sep}`) ||
        resolvedGitDir === resolvedMainGitDir
      );
    } catch {
      return false;
    }
  }

  /**
   * Where worktrees lived before they were moved out of the repo. Only read,
   * never written: an in-flight worktree from a previous version must still be
   * findable (and removable) after an upgrade.
   */
  private legacyWorktreePath(branch: string): string {
    return `${this.repoPath}/.git/crew-worktrees/${sanitizeBranch(branch)}`;
  }

  async syncBase(): Promise<void> {
    try {
      await this.git(["-C", this.repoPath, "fetch", "origin", this.baseBranch]);
    } catch (err) {
      throw new Error(
        `syncBase: could not fetch origin/${this.baseBranch}: ${
          (err as Error).message
        }`,
      );
    }
  }

  /**
   * Path of an existing, usable worktree for `branch`, or null. "Usable" means
   * the directory is present AND git still tracks it as a worktree — a pruned
   * or hand-deleted one must not be resumed.
   */
  async findWorktree(branch: string): Promise<string | null> {
    const candidates: string[] = [];

    // A retained slot holding this branch is the resume target: it has the
    // verified commit that failed to land. Missing it would mean paying an
    // agent to redo work that is already done and already proven.
    if (this.pool) {
      const dir = this.worktreeRoot();
      const held = findSlotForBranch(dir, this.pool.max, branch);
      if (held) candidates.push(slotPath(dir, held.slot));
    }

    // Per-branch and legacy locations are still checked even when pooling: an
    // upgrade must not strand an in-flight worktree that predates the pool.
    candidates.push(this.worktreePath(branch), this.legacyWorktreePath(branch));

    for (const wt of candidates) {
      if (!existsSync(wt)) continue;
      try {
        const list = await this.git(["-C", this.repoPath, "worktree", "list", "--porcelain"]);
        // Compare resolved paths: `worktree list` reports symlink-resolved paths
        // (on macOS /tmp -> /private/tmp), which would otherwise never match.
        const want = realpathSync(wt);
        const tracked = list
          .split("\n")
          .filter((l) => l.startsWith("worktree "))
          .map((l) => l.slice("worktree ".length).trim());
        const match = tracked.some((p) => {
          try {
            return realpathSync(p) === want;
          } catch {
            return false;
          }
        });
        if (match) return wt;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * A branch that makes `branch` impossible to create, or null.
   *
   * Git stores refs as paths, so `refs/heads/crew` being a FILE means
   * `refs/heads/crew/probe-verify` cannot be a directory. A user with a branch
   * literally named `crew` (or `agent`) therefore blocks every worktree crew
   * creates — and git reports it as "cannot lock ref", which names the ref it
   * failed to create rather than the existing branch that is in the way.
   */
  private async blockingBranch(branch: string): Promise<string | null> {
    const parts = branch.split("/");
    // Every proper prefix: "a/b/c" is blocked by a branch named "a" or "a/b".
    const prefixes = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
    if (!prefixes.length) return null;
    for (const p of prefixes) {
      const found = await this.git([
        "-C",
        this.repoPath,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${p}`,
      ])
        .then(() => true)
        .catch(() => false);
      if (found) return p;
    }
    return null;
  }

  /** Explain a ref collision in terms of the branch the user actually has. */
  private blockedError(branch: string, blocker: string): Error {
    return new Error(
      `cannot create the branch \`${branch}\`: you have a branch named \`${blocker}\`, and git ` +
        `cannot store a branch under a name that is already a branch itself. Rename or delete ` +
        `\`${blocker}\` (e.g. \`git branch -m ${blocker} ${blocker}-wip\`), then try again.`,
    );
  }

  async createWorktree(branch: string): Promise<string> {
    if (this.pool) return this.acquirePooled(branch);

    const wt = this.worktreePath(branch);

    // Idempotent cleanup: a killed/interrupted run can leave the worktree and
    // branch behind, which would make `worktree add -b` fail with "already
    // exists". Clear any leftovers for this branch before recreating.
    // Both locations are cleared: a leftover at the legacy path still holds the
    // branch, which would make `worktree add -b` fail with "already exists".
    await this.git(["-C", this.repoPath, "worktree", "prune"]).catch(() => {});
    for (const stale of [wt, this.legacyWorktreePath(branch)]) {
      await this.git(["-C", this.repoPath, "worktree", "remove", "--force", stale]).catch(() => {});
      try {
        rmSync(stale, { recursive: true, force: true }); // orphaned dir not tracked by git
      } catch {
        /* ignore */
      }
    }
    // Delete a leftover local branch from a prior failed attempt. Safe on two
    // counts: a successful run's branch is on In Review (not re-selected), and
    // the executor only calls this when findWorktree() found nothing resumable
    // — a preserved worktree holding a real commit never reaches here.
    await this.git(["-C", this.repoPath, "branch", "-D", branch]).catch(() => {});

    // Checked after the cleanup above, so a leftover `agent/ABC-1` from a prior
    // run is deleted rather than reported as a blocker.
    const blocker = await this.blockingBranch(branch);
    if (blocker) throw this.blockedError(branch, blocker);

    await this.git([
      "-C",
      this.repoPath,
      "worktree",
      "add",
      "-b",
      branch,
      wt,
      `origin/${this.baseBranch}`,
    ]);
    // Best-effort: point hooks at the repo's tracked .githooks dir.
    try {
      await this.git(["-C", wt, "config", "core.hooksPath", ".githooks"]);
    } catch {
      // ignore — hooks are optional
    }
    return wt;
  }

  async hasCommits(worktreePath: string): Promise<boolean> {
    const out = await this.git([
      "-C",
      worktreePath,
      "log",
      `origin/${this.baseBranch}..HEAD`,
      "--oneline",
    ]);
    return out.length > 0;
  }

  /**
   * A snapshot of the MAIN checkout's HEAD and working-tree state.
   *
   * This is deliberately relative, not absolute: the user's checkout is
   * routinely on a feature branch, ahead of origin, with uncommitted edits of
   * their own. Comparing against `origin/base` would flag all of that as agent
   * damage on every run. Only a change BETWEEN two snapshots means the agent
   * touched the checkout, so the engine takes one before the run and one after.
   */
  async checkoutSnapshot(): Promise<CheckoutSnapshot> {
    const head = await this.git(["-C", this.repoPath, "rev-parse", "HEAD"]).catch(() => "");
    const dirty = await this.git(["-C", this.repoPath, "status", "--porcelain"]).catch(() => "");
    return {
      head,
      dirty: dirty
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    };
  }

  /**
   * Diff two checkout snapshots into "what the agent did to the user's main
   * checkout while it was supposed to be working in its worktree". Empty means
   * the checkout is exactly as the agent found it.
   */
  async strayWork(before: CheckoutSnapshot): Promise<{ commits: string[]; dirtyFiles: string[] }> {
    const after = await this.checkoutSnapshot();

    // New commits are those reachable from the new HEAD but not the old one.
    // If HEAD is unchanged there are none, and the range query is skipped —
    // that also avoids a bogus result when the branch was switched underneath.
    let commits: string[] = [];
    if (after.head && before.head && after.head !== before.head) {
      const out = await this.git([
        "-C",
        this.repoPath,
        "log",
        `${before.head}..${after.head}`,
        "--oneline",
      ]).catch(() => "");
      commits = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      // A branch switch (rather than new work) yields nothing on that range;
      // report the HEAD move itself so it is still visible.
      if (!commits.length) commits = [`HEAD moved ${before.head.slice(0, 9)} → ${after.head.slice(0, 9)}`];
    }

    // Only working-tree entries that weren't already there before the run.
    const had = new Set(before.dirty);
    const dirtyFiles = after.dirty.filter((l) => !had.has(l));

    return { commits, dirtyFiles };
  }

  private async changedFiles(worktreePath: string): Promise<string[]> {
    const out = await this.git([
      "-C",
      worktreePath,
      "diff",
      "--name-only",
      `origin/${this.baseBranch}...HEAD`,
    ]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async changedApps(
    worktreePath: string,
    appNames: string[],
  ): Promise<string[]> {
    const files = await this.changedFiles(worktreePath);
    const changed = new Set<string>();
    for (const name of appNames) {
      const appPrefix = `apps/${name}/`;
      const barePrefix = `${name}/`;
      for (const f of files) {
        if (f.startsWith(appPrefix) || f.startsWith(barePrefix)) {
          changed.add(name);
          break;
        }
      }
    }
    return appNames.filter((n) => changed.has(n));
  }

  async noTouchViolations(
    worktreePath: string,
    globs: string[],
  ): Promise<string[]> {
    const files = await this.changedFiles(worktreePath);
    return files.filter((f) => matchesAny(f, globs));
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    await this.git(["-C", worktreePath, "push", "-u", "origin", branch]);
  }

  async openPr(opts: OpenPrOptions): Promise<string> {
    return this.forge.openPr(opts);
  }

  /** Post a comment on an existing PR (used by reviewer agents). */
  async commentOnPr(prUrl: string, body: string): Promise<void> {
    await this.forge.commentOnPr(prUrl, body);
  }

  /**
   * Give up a worktree.
   *
   * For a pooled slot this RELEASES rather than deletes: the checkout and its
   * build artifacts staying on disk is the entire point of the pool. For an
   * unpooled worktree — and for anything at a legacy path — it removes, exactly
   * as before.
   */
  async removeWorktree(worktreePath: string): Promise<void> {
    const slot = this.pooledSlotAt(worktreePath);
    if (slot !== null) {
      releaseSlot(this.worktreeRoot(), slot, false);
      return;
    }

    try {
      await this.git([
        "-C",
        this.repoPath,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Mark a worktree as holding work that must not be recycled — a verified
   * commit that failed to land, or an escape that needs a human. No-op when
   * unpooled: there the engine keeps the directory itself.
   */
  async retainWorktree(worktreePath: string): Promise<void> {
    const slot = this.pooledSlotAt(worktreePath);
    if (slot === null) return;
    releaseSlot(this.worktreeRoot(), slot, true);
  }

  /** Slot number if `path` is one of this pool's slots, else null. */
  private pooledSlotAt(path: string): number | null {
    if (!this.pool) return null;
    const dir = this.worktreeRoot();
    for (let i = 0; i < this.pool.max; i++) {
      if (slotPath(dir, i) === path) return i;
    }
    return null;
  }
}
