import { execFile } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import type { ForgePort, GitPort, OpenPrOptions } from "../types.js";
import { matchesAny } from "../util/glob.js";
import { GitHubForge } from "./forge/github.js";

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

  constructor(
    private readonly repoPath: string,
    private readonly baseBranch: string,
    /** Defaults to GitHub so existing callers keep their behaviour. */
    forge?: ForgePort,
  ) {
    this.forge = forge ?? new GitHubForge(repoPath);
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

  private worktreePath(branch: string): string {
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
    const wt = this.worktreePath(branch);
    if (!existsSync(wt)) return null;
    try {
      const list = await this.git(["-C", this.repoPath, "worktree", "list", "--porcelain"]);
      // Compare resolved paths: `worktree list` reports symlink-resolved paths
      // (on macOS /tmp -> /private/tmp), which would otherwise never match.
      const want = realpathSync(wt);
      const tracked = list
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim());
      return tracked.some((p) => {
        try {
          return realpathSync(p) === want;
        } catch {
          return false;
        }
      })
        ? wt
        : null;
    } catch {
      return null;
    }
  }

  async createWorktree(branch: string): Promise<string> {
    const wt = this.worktreePath(branch);

    // Idempotent cleanup: a killed/interrupted run can leave the worktree and
    // branch behind, which would make `worktree add -b` fail with "already
    // exists". Clear any leftovers for this branch before recreating.
    await this.git(["-C", this.repoPath, "worktree", "prune"]).catch(() => {});
    await this.git(["-C", this.repoPath, "worktree", "remove", "--force", wt]).catch(() => {});
    try {
      rmSync(wt, { recursive: true, force: true }); // orphaned dir not tracked by git
    } catch {
      /* ignore */
    }
    // Delete a leftover local branch from a prior failed attempt. Safe on two
    // counts: a successful run's branch is on In Review (not re-selected), and
    // the executor only calls this when findWorktree() found nothing resumable
    // — a preserved worktree holding a real commit never reaches here.
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

  async removeWorktree(worktreePath: string): Promise<void> {
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
}
