import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAdapter } from "./git.js";

/**
 * Worktrees must live OUTSIDE the repo. They used to be created at
 * `<repo>/.git/crew-worktrees/`, which git tolerates but the rest of the
 * toolchain does not: a working tree inside `.git` is exempt from git's ignore
 * rules yet fully visible to anything that walks the filesystem. A pnpm/npm
 * workspace glob (`packages: ["**"]`) descends into it and adopts the worktree
 * as a phantom member of the main repo, so an install there rewrites the parent
 * checkout's package.json and lockfile.
 */

function repo(): { path: string; git: GitAdapter; run: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "crew-wt-"));
  const path = join(root, "myrepo");
  execFileSync("git", ["init", "-q", path]);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  run("config", "user.email", "t@t.co");
  run("config", "user.name", "T");
  writeFileSync(join(path, "a.txt"), "base\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("branch", "-M", "main");
  // createWorktree branches off origin/<base>, so give the repo an "origin"
  // that simply points at itself — enough for the ref to resolve.
  run("remote", "add", "origin", path);
  run("fetch", "-q", "origin");
  return { path, git: new GitAdapter(path, "main"), run };
}

test("a worktree is created outside the repo, not inside .git", async () => {
  const { path, git } = repo();
  const wt = await git.createWorktree("agent/abc-1");

  assert.ok(!wt.includes("/.git/"), `worktree must not live inside .git: ${wt}`);
  assert.ok(!wt.startsWith(path + "/"), `worktree must not live inside the repo: ${wt}`);
  assert.ok(existsSync(wt), "the worktree directory exists");
});

test("a filesystem walk of the repo cannot reach the worktree", async () => {
  const { path, git } = repo();
  const wt = await git.createWorktree("agent/abc-1");
  writeFileSync(join(wt, "package.json"), '{"name":"wt"}\n');

  // This is the workspace-glob failure in miniature: `find` over the repo used
  // to turn up the worktree's package.json via .git/crew-worktrees.
  const found = execFileSync("find", [path, "-name", "package.json"], { encoding: "utf8" });
  assert.equal(found.trim(), "", "no worktree file may be reachable from the repo tree");
});

test("the worktree is a real, committable git worktree", async () => {
  const { git } = repo();
  const wt = await git.createWorktree("agent/abc-1");
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();

  assert.equal(run("branch", "--show-current"), "agent/abc-1");
  writeFileSync(join(wt, "new.txt"), "work\n");
  run("add", "-A");
  run("commit", "-qm", "feat: work");
  assert.equal(await git.hasCommits(wt), true);
});

test("creating a worktree twice for the same branch is idempotent", async () => {
  const { git } = repo();
  await git.createWorktree("agent/abc-1");
  const second = await git.createWorktree("agent/abc-1");
  assert.ok(existsSync(second), "recreating must succeed, not fail on 'already exists'");
});

test("a worktree left at the legacy .git path is still found after upgrade", async () => {
  const { path, git, run } = repo();
  // Simulate a pre-upgrade worktree holding a verified commit.
  const legacy = join(path, ".git", "crew-worktrees", "agent-abc-1");
  run("worktree", "add", "-q", legacy, "-b", "agent/abc-1");

  const found = await git.findWorktree("agent/abc-1");
  assert.equal(found, legacy, "preserved work from the old location must not be stranded");
});

test("a stale legacy worktree does not block creating the new one", async () => {
  const { path, git, run } = repo();
  const legacy = join(path, ".git", "crew-worktrees", "agent-abc-1");
  run("worktree", "add", "-q", legacy, "-b", "agent/abc-1");

  // The branch is held by the legacy worktree; creating fresh must clear it.
  const wt = await git.createWorktree("agent/abc-1");
  assert.ok(!wt.includes("/.git/"), "the new worktree is at the new location");
  assert.ok(existsSync(wt));
  assert.ok(!existsSync(legacy), "the stale legacy worktree is cleaned up");
});

test("findWorktree returns null when nothing exists at either location", async () => {
  const { git } = repo();
  assert.equal(await git.findWorktree("agent/nope"), null);
});
