/**
 * Provider selection for the code host, mirroring `tracker/factory.ts`.
 *
 * This is the only place that knows which forges exist. `GitAdapter` holds a
 * `ForgePort` and nothing more, so a third host can be added without touching
 * the engine.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CrewConfig, ForgePort, ForgeProvider } from "../../types.js";
import { GitHubForge } from "./github.js";
import { BitbucketForge, parseBitbucketRemote } from "./bitbucket.js";

const pExecFile = promisify(execFile);

export class ForgeAuthError extends Error {}

/**
 * Env vars each forge needs, for `crew doctor` and the error below. GitHub is
 * empty because `gh` carries its own auth — doctor checks `gh auth status`
 * instead. Bitbucket accepts either an access token or a username + app
 * password, so the requirement is a choice rather than a flat list.
 */
export const FORGE_ENV: Record<ForgeProvider, string[][]> = {
  github: [],
  bitbucket: [["BITBUCKET_ACCESS_TOKEN"], ["BITBUCKET_USERNAME", "BITBUCKET_APP_PASSWORD"]],
};

/** True when at least one of the accepted credential sets is fully present. */
export function forgeCredentialsPresent(provider: ForgeProvider): boolean {
  const options = FORGE_ENV[provider];
  if (options.length === 0) return true;
  return options.some((set) => set.every((v) => !!process.env[v]?.trim()));
}

/** Human-readable "A, or B and C" description of what a forge needs. */
export function forgeEnvHint(provider: ForgeProvider): string {
  return FORGE_ENV[provider].map((set) => set.join(" + ")).join(", or ");
}

/** Read the origin remote URL, or "" when there is no origin. */
async function originUrl(repoPath: string): Promise<string> {
  try {
    const { stdout } = await pExecFile("git", [
      "-C",
      repoPath,
      "remote",
      "get-url",
      "origin",
    ]);
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the Bitbucket `workspace/repo-slug`: the config value if set,
 * otherwise inferred from the origin remote.
 */
export async function resolveBitbucketRepo(cfg: CrewConfig): Promise<string> {
  const configured = cfg.repo.bitbucketRepo?.trim();
  if (configured) return configured;

  const remote = await originUrl(cfg.repo.path);
  const slug = remote ? parseBitbucketRemote(remote) : null;
  if (!slug) {
    throw new ForgeAuthError(
      `Could not determine the Bitbucket repository for ${cfg.repo.path}. ` +
        `Set \`repo.bitbucketRepo: "workspace/repo-slug"\` in ${cfg.configDir}/config.yaml, ` +
        `or point the \`origin\` remote at bitbucket.org.` +
        (remote ? ` (origin is currently "${remote}")` : " (no origin remote is set)"),
    );
  }
  return slug;
}

/**
 * Construct the configured forge adapter. Throws `ForgeAuthError` naming the
 * exact missing variables — the most common first-run failure.
 */
export async function createForge(cfg: CrewConfig): Promise<ForgePort> {
  const provider = cfg.repo.forge;

  switch (provider) {
    case "github":
      // `gh` authenticates itself; nothing to check here.
      return new GitHubForge(cfg.repo.path);

    case "bitbucket": {
      if (!forgeCredentialsPresent("bitbucket")) {
        throw new ForgeAuthError(
          `Bitbucket credentials are not set. Provide ${forgeEnvHint("bitbucket")} ` +
            `in ${cfg.configDir}/.env or ~/.crew/env, or export them in your shell.`,
        );
      }
      return new BitbucketForge(
        {
          accessToken: process.env.BITBUCKET_ACCESS_TOKEN?.trim() || undefined,
          username: process.env.BITBUCKET_USERNAME?.trim() || undefined,
          appPassword: process.env.BITBUCKET_APP_PASSWORD?.trim() || undefined,
        },
        await resolveBitbucketRepo(cfg),
      );
    }

    default: {
      // Unreachable while the schema enum and this switch agree; kept so adding
      // a provider to the enum without an adapter fails to compile.
      const exhaustive: never = provider;
      throw new ForgeAuthError(`Unknown forge provider: ${String(exhaustive)}`);
    }
  }
}
