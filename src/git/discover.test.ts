import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigRoot, inspectRepo, parseRemoteUrl, trackedFileCount } from "./discover.js";

/**
 * Remote URL parsing. Git accepts several spellings for the same remote, and
 * the forge is derived from the host, so each shape has to land on the same
 * host/path pair.
 */

test("parses the scp-ish form git uses for ssh remotes", () => {
  assert.deepEqual(parseRemoteUrl("git@github.com:acme/app.git"), {
    host: "github.com",
    path: "acme/app",
  });
});

test("parses https remotes, dropping the .git suffix", () => {
  assert.deepEqual(parseRemoteUrl("https://bitbucket.org/ws/repo.git"), {
    host: "bitbucket.org",
    path: "ws/repo",
  });
});

test("parses an explicit ssh:// URL", () => {
  assert.deepEqual(parseRemoteUrl("ssh://git@github.com/acme/app"), {
    host: "github.com",
    path: "acme/app",
  });
});

test("hosts compare case-insensitively", () => {
  assert.equal(parseRemoteUrl("https://GitHub.com/acme/app")?.host, "github.com");
});

test("a garbage remote yields null rather than a bogus host", () => {
  assert.equal(parseRemoteUrl("not a url"), null);
  assert.equal(parseRemoteUrl(""), null);
});

/** Create a git repo in a temp dir, optionally with an origin remote. */
function tempRepo(origin?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crew-git-")));
  execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  if (origin) {
    execFileSync("git", ["-C", root, "remote", "add", "origin", origin], {
      stdio: "ignore",
    });
  }
  return root;
}

test("inspectRepo reports the toplevel when called from a subdirectory", () => {
  const root = tempRepo();
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });

  assert.equal(inspectRepo(nested).root, root);
});

test("inspectRepo returns nothing for a directory outside any repo", () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "crew-plain-")));
  assert.deepEqual(inspectRepo(plain), {});
});

test("inspectRepo derives the forge and slug from a bitbucket origin", () => {
  const facts = inspectRepo(tempRepo("git@bitbucket.org:ws/repo.git"));
  assert.equal(facts.forge, "bitbucket");
  assert.equal(facts.bitbucketRepo, "ws/repo");
});

test("inspectRepo leaves the forge unset for an unrecognized host", () => {
  const facts = inspectRepo(tempRepo("git@git.example.com:ws/repo.git"));
  assert.equal(facts.forge, undefined);
  // The URL still comes back, so setup can show it when asking.
  assert.equal(facts.originUrl, "git@git.example.com:ws/repo.git");
});

test("inspectRepo omits baseBranch when the repo has no origin/HEAD", () => {
  assert.equal(inspectRepo(tempRepo()).baseBranch, undefined);
});

/** findConfigRoot walks up the way git and npm locate their own roots. */

test("findConfigRoot finds the marker from deep inside the tree", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crew-find-")));
  mkdirSync(join(root, ".crew"), { recursive: true });
  writeFileSync(join(root, ".crew", "config.yaml"), "");
  const nested = join(root, "x", "y", "z");
  mkdirSync(nested, { recursive: true });

  assert.equal(findConfigRoot(nested, ".crew"), root);
});

test("findConfigRoot returns null when no crew dir exists above the start", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crew-none-")));
  assert.equal(findConfigRoot(root, ".crew-definitely-absent"), null);
});

/**
 * Tracked-file count gates the worktree-reuse question at setup, so a wrong
 * answer either hides the option from a repo that needs it or offers a bad
 * trade to one that doesn't.
 */

test("trackedFileCount counts tracked files, ignoring untracked ones", () => {
  const root = tempRepo();
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(root, "b.txt"), "b");
  execFileSync("git", ["-C", root, "add", "a.txt", "b.txt"], { stdio: "ignore" });
  writeFileSync(join(root, "untracked.txt"), "c");

  assert.equal(trackedFileCount(root), 2);
});

test("trackedFileCount is 0 for a repo with nothing committed", () => {
  assert.equal(trackedFileCount(tempRepo()), 0);
});

test("trackedFileCount returns null outside a git repo", () => {
  // Setup must not offer worktree reuse based on a failed measurement.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "crew-nogit-")));
  assert.equal(trackedFileCount(plain), null);
});
