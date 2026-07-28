import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitAdapter } from "./git.js";
import { readMeta } from "./pool.js";

/**
 * End-to-end checks that pooled worktrees behave like real git worktrees, and
 * that the reset between cycles keeps build artifacts while dropping the
 * previous agent's work. Both halves matter: keeping too little makes pooling
 * pointless, keeping too much lets one cycle's output satisfy the next cycle's
 * verify gate.
 */

const POOL = { max: 2, preserveArtifacts: ["node_modules"], recycleAfter: 20 };

function repo(pool?: typeof POOL): {
  path: string;
  git: GitAdapter;
  poolDir: string;
  run: (...a: string[]) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "crew-poolint-"));
  const path = join(root, "myrepo");
  execFileSync("git", ["init", "-q", path]);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  run("config", "user.email", "t@t.co");
  run("config", "user.name", "T");
  writeFileSync(join(path, "a.txt"), "base\n");
  // Real repos ignore their dependency and build dirs, which is what keeps them
  // untracked — and therefore reachable by the artifact-preserving reset path.
  writeFileSync(join(path, ".gitignore"), "node_modules/\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("branch", "-M", "main");
  run("remote", "add", "origin", path);
  run("fetch", "-q", "origin");
  return {
    path,
    git: new GitAdapter(path, "main", undefined, pool),
    poolDir: join(dirname(path), ".crew-worktrees-myrepo"),
    run,
  };
}

test("a pooled worktree is a real, committable git worktree", async () => {
  const { git } = repo(POOL);
  const wt = await git.createWorktree("agent/abc-1");
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();

  assert.equal(run("branch", "--show-current"), "agent/abc-1");
  writeFileSync(join(wt, "new.txt"), "work\n");
  run("add", "-A");
  run("commit", "-qm", "feat: work");
  assert.equal(await git.hasCommits(wt), true);
});

test("releasing a pooled slot keeps the checkout on disk", async () => {
  const { git, poolDir } = repo(POOL);
  const wt = await git.createWorktree("agent/abc-1");
  await git.removeWorktree(wt);

  // The whole point: the next cycle must not pay for a fresh checkout.
  assert.ok(existsSync(wt), "a released slot keeps its working tree");
  assert.equal(readMeta(poolDir, 0).state, "free");
});

test("a reused slot keeps preserved artifacts and drops the last agent's work", async () => {
  const { git } = repo(POOL);
  const first = await git.createWorktree("agent/abc-1");

  // Stand in for an installed dependency tree and a build cache.
  mkdirSync(join(first, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(first, "node_modules", "left-pad", "index.js"), "module.exports=1\n");
  // ...and for the previous agent's actual work.
  writeFileSync(join(first, "scratch.txt"), "leftover\n");
  writeFileSync(join(first, "a.txt"), "MODIFIED BY AGENT\n");
  execFileSync("git", ["-C", first, "add", "-A"]);
  execFileSync("git", ["-C", first, "-c", "user.email=t@t.co", "-c", "user.name=T",
    "commit", "-qm", "agent work"]);

  await git.removeWorktree(first);
  const second = await git.createWorktree("agent/abc-2");
  assert.equal(second, first, "the same slot is reused");

  assert.ok(
    existsSync(join(second, "node_modules", "left-pad", "index.js")),
    "preserved artifacts survive — this is what makes reuse worth doing",
  );
  assert.ok(!existsSync(join(second, "scratch.txt")), "untracked leftovers are removed");
  assert.equal(
    execFileSync("git", ["-C", second, "show", ":a.txt"], { encoding: "utf8" }),
    "base\n",
    "tracked files are reset to base, not left at the last agent's version",
  );
  assert.equal(
    execFileSync("git", ["-C", second, "branch", "--show-current"], { encoding: "utf8" }).trim(),
    "agent/abc-2",
  );
  assert.equal(await git.hasCommits(second), false, "the new branch starts clean");
});

test("a deep clean drops preserved artifacts too", async () => {
  const { git } = repo({ ...POOL, recycleAfter: 1 });
  const first = await git.createWorktree("agent/abc-1");
  mkdirSync(join(first, "node_modules"), { recursive: true });
  writeFileSync(join(first, "node_modules", "x.js"), "1\n");
  await git.removeWorktree(first);

  // useCount hits recycleAfter, so residue is cleared rather than accumulating
  // indefinitely behind the fast path.
  const second = await git.createWorktree("agent/abc-2");
  assert.ok(!existsSync(join(second, "node_modules")), "the periodic deep clean is honest");
});

test("a retained slot is not reused, and resume finds its commit", async () => {
  const { git } = repo(POOL);
  const wt = await git.createWorktree("agent/abc-1");
  writeFileSync(join(wt, "new.txt"), "work\n");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "-c", "user.email=t@t.co", "-c", "user.name=T",
    "commit", "-qm", "verified work"]);
  await git.retainWorktree(wt);

  const other = await git.createWorktree("agent/abc-2");
  assert.notEqual(other, wt, "retained work must not be handed to the next agent");

  const found = await git.findWorktree("agent/abc-1");
  assert.equal(found, wt, "resume must reach the verified commit");
  assert.equal(await git.hasCommits(wt), true);
});

test("with reuse off, worktrees are still per-branch and removed", async () => {
  const { git } = repo(); // no pool
  const wt = await git.createWorktree("agent/abc-1");
  assert.ok(wt.endsWith("agent-abc-1"), "unpooled worktrees keep their branch-derived path");
  await git.removeWorktree(wt);
  assert.ok(!existsSync(wt), "unpooled worktrees are still deleted on release");
});

test("an unpooled adapter never touches the pool, so the probe stays cold", async () => {
  // The cold-verify probe builds its own adapter without pool options. If it
  // ever got a pooled one it would verify against a warm tree, which is exactly
  // the thing it exists to rule out.
  const { path, poolDir } = repo();
  const cold = new GitAdapter(path, "main"); // how probe.ts constructs it
  const wt = await cold.createWorktree("crew/probe-verify");
  assert.ok(!wt.startsWith(join(poolDir, "slot-")), "the probe must not land in a pool slot");
  await cold.removeWorktree(wt);
  assert.ok(!existsSync(wt), "the probe's worktree is destroyed, never released");
});

test("a pooled slot whose checkout was deleted underneath is rebuilt", async () => {
  const { git, poolDir } = repo(POOL);
  const wt = await git.createWorktree("agent/abc-1");
  await git.removeWorktree(wt);
  // Simulate a user clearing disk space, or an interrupted reset.
  execFileSync("rm", ["-rf", wt]);

  const again = await git.createWorktree("agent/abc-2");
  assert.equal(again, wt, "the same slot path is reused");
  assert.ok(existsSync(join(again, "a.txt")), "the checkout is recreated cold");
  assert.equal(readMeta(poolDir, 0).state, "busy");
});

test("a pooled slot whose .git is corrupted is rebuilt, not handed to the agent", async () => {
  const { git, poolDir } = repo(POOL);
  const wt = await git.createWorktree("agent/abc-1");
  await git.removeWorktree(wt);
  // Simulate a broken worktree link: the directory and git's own registry
  // both still say this slot is a worktree, but the slot's `.git` file no
  // longer resolves — e.g. a half-finished reset or something clobbering it.
  writeFileSync(join(wt, ".git"), "gitdir: /nowhere/does/not/exist\n");

  const again = await git.createWorktree("agent/abc-2");
  assert.equal(again, wt, "the same slot path is reused");
  assert.ok(existsSync(join(again, "a.txt")), "the checkout is recreated cold");
  execFileSync("git", ["-C", again, "rev-parse", "--git-dir"]); // must not throw
  assert.equal(readMeta(poolDir, 0).state, "busy");
});

test("a blocking branch fails before a pool slot is consumed", async () => {
  // Checked before acquireSlot: the branch can never be created, so claiming a
  // slot would burn one and then fail anyway — and on a full pool that would
  // starve real work behind a name that is never going to succeed.
  const { git, poolDir, run } = repo({ max: 1, preserveArtifacts: [], recycleAfter: 0 });
  run("branch", "agent");

  await assert.rejects(
    () => git.createWorktree("agent/abc-1"),
    /you have a branch named `agent`/,
  );
  assert.equal(readMeta(poolDir, 0).state, "free", "the slot was never taken");
});
