import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ForgePort, OpenPrOptions } from "../../types.js";

const pExecFile = promisify(execFile);

/** GitHub, driven through the `gh` CLI (which carries its own auth). */
export class GitHubForge implements ForgePort {
  constructor(private readonly repoPath: string) {}

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

  /**
   * Post a comment on an existing PR. `gh pr comment` accepts the PR URL
   * directly, so this works from any cwd inside the repo.
   */
  async commentOnPr(prUrl: string, body: string): Promise<void> {
    await pExecFile("gh", ["pr", "comment", prUrl, "--body", body], {
      cwd: this.repoPath,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}
