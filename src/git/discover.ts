import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { ForgeProvider } from "../types.js";

/**
 * Repo facts crew can read straight out of git rather than asking for. Every
 * field is optional: git may be missing, the directory may not be a repo, and a
 * repo may have no `origin` — in all of those cases inference simply yields
 * nothing and the caller falls back to whatever the config says.
 */
export interface RepoFacts {
  /** Absolute path to the repo's toplevel (working-tree root). */
  root?: string;
  /** Default branch on `origin`, from `refs/remotes/origin/HEAD`. */
  baseBranch?: string;
  /** Code host derived from the `origin` remote's URL. */
  forge?: ForgeProvider;
  /** `workspace/repo-slug`, only set when the origin remote is Bitbucket. */
  bitbucketRepo?: string;
  /** The `origin` remote URL, verbatim, for error messages. */
  originUrl?: string;
}

/**
 * Run git synchronously, returning trimmed stdout or null on any failure.
 * Config loading is synchronous everywhere else, and these are sub-millisecond
 * local calls, so the sync form keeps `loadConfig` from going async.
 */
function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse the host and `owner/repo` path out of a git remote URL. Handles both
 * the SCP-ish form (`git@host:owner/repo.git`) and real URLs
 * (`https://host/owner/repo.git`, `ssh://git@host/owner/repo`).
 */
export function parseRemoteUrl(
  url: string,
): { host: string; path: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // SCP-ish syntax has no scheme and puts a colon between host and path.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (scp && !trimmed.includes("://")) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }

  host = host.toLowerCase();
  path = path.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  return { host, path };
}

/** Map a remote host to the forge that serves it, or null when unrecognized. */
function forgeForHost(host: string): ForgeProvider | null {
  // Match on a trailing domain segment so self-hosted subdomains
  // (github.acme.com, bitbucket.acme.com) resolve the same way.
  if (host === "github.com" || host.endsWith(".github.com") || host.startsWith("github."))
    return "github";
  if (
    host === "bitbucket.org" ||
    host.endsWith(".bitbucket.org") ||
    host.startsWith("bitbucket.")
  )
    return "bitbucket";
  return null;
}

/**
 * Walk up from `startDir` looking for a directory containing `dirName` (the
 * crew config dir). Returns the containing directory, or null if the
 * filesystem root is reached without a match — the same upward search git and
 * npm do, so `crew run` works from anywhere inside the repo.
 */
export function findConfigRoot(startDir: string, dirName: string): string | null {
  let dir = resolve(startDir);
  const { root } = parse(dir);
  for (;;) {
    if (existsSync(join(dir, dirName, "config.yaml"))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read everything crew can infer about the repo containing `dir`. Never throws:
 * a missing git binary, a non-repo directory, or a remote-less repo each just
 * narrow how much comes back.
 */
export function inspectRepo(dir: string): RepoFacts {
  const facts: RepoFacts = {};
  if (!existsSync(dir)) return facts;

  const root = git(["rev-parse", "--show-toplevel"], dir);
  if (!root) return facts; // not a git repo — nothing else is meaningful
  facts.root = resolve(root);

  // `origin/HEAD` is only present when someone has set it (clone does; `git
  // init` + `git remote add` does not), so treat its absence as unknown rather
  // than guessing a branch name.
  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], dir);
  if (head) {
    const name = head.replace(/^refs\/remotes\/origin\//, "");
    if (name) facts.baseBranch = name;
  }

  const originUrl = git(["remote", "get-url", "origin"], dir);
  if (originUrl) {
    facts.originUrl = originUrl;
    const parsed = parseRemoteUrl(originUrl);
    if (parsed) {
      const forge = forgeForHost(parsed.host);
      if (forge) facts.forge = forge;
      // Bitbucket Cloud addresses a repo as "workspace/repo-slug"; anything
      // deeper in the path is not part of that identifier.
      if (forge === "bitbucket") {
        const segments = parsed.path.split("/").filter(Boolean);
        if (segments.length >= 2) {
          facts.bitbucketRepo = `${segments[0]}/${segments[1]}`;
        }
      }
    }
  }

  return facts;
}

/** True when `dir` is inside a git working tree. */
export function isGitRepo(dir: string): boolean {
  return git(["rev-parse", "--is-inside-work-tree"], dir) === "true";
}

/**
 * How many files git tracks in `dir`, or null if it can't be determined.
 *
 * Used to decide whether worktree reuse is even worth asking about. File count
 * rather than bytes on disk: checkout cost is dominated by creating inodes, so
 * a repo of many small files is slower to materialize than one large binary of
 * the same total size.
 */
export function trackedFileCount(dir: string): number | null {
  // Not routed through the `git` helper above: it collapses empty output to
  // null, which would make an empty repo indistinguishable from a missing one.
  // Here that difference is real — 0 is a measurement, null is a failure.
  try {
    const out = execFileSync("git", ["ls-files", "--", "."], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024, // a large monorepo's file list is large
    });
    const trimmed = out.trim();
    return trimmed === "" ? 0 : trimmed.split("\n").length;
  } catch {
    return null;
  }
}
