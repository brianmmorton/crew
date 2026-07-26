import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitPort, OpenPrOptions } from "../types.js";
import { matchesAny } from "../util/glob.js";

const pExecFile = promisify(execFile);

/** Turn a branch name into a filesystem-safe directory segment. */
function sanitizeBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export class GitAdapter implements GitPort {
  constructor(
    private readonly repoPath: string,
    private readonly baseBranch: string,
  ) {}

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

  async createWorktree(branch: string): Promise<string> {
    const wt = this.worktreePath(branch);
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
    const base = ["pr", "create",
      "--base", opts.baseBranch,
      "--head", opts.branch,
      "--title", opts.title,
      "--body", opts.body,
      "--assignee", opts.assignee,
    ];

    const run = async (args: string[]): Promise<string> => {
      const { stdout } = await pExecFile("gh", args, {
        cwd: opts.repoPath,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    };

    let stdout: string;
    if (opts.label) {
      try {
        stdout = await run([...base, "--label", opts.label]);
      } catch {
        // Label may not exist on the repo — retry once without it.
        stdout = await run([...base]);
      }
    } else {
      stdout = await run([...base]);
    }

    // gh prints the PR URL on the last non-empty line.
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const urlLine =
      [...lines].reverse().find((l) => /^https?:\/\//.test(l)) ??
      lines[lines.length - 1] ??
      "";
    return urlLine;
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
