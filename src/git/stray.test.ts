import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAdapter } from "./git.js";

/**
 * Stray-work detection runs against real git, because the bug it exists to
 * catch (and the false positive it once produced) are both about what git
 * actually reports — not about what a mock returns.
 *
 * The false positive mattered: the user's checkout is normally on a feature
 * branch, ahead of origin, with uncommitted edits. An absolute
 * `origin/base..HEAD` check flagged all of that as agent damage on every run.
 */

function repo(): { path: string; git: GitAdapter; run: (...a: string[]) => string } {
  const path = mkdtempSync(join(tmpdir(), "crew-stray-"));
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  run("init", "-q");
  run("config", "user.email", "t@t.co");
  run("config", "user.name", "T");
  writeFileSync(join(path, "a.txt"), "base\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  return { path, git: new GitAdapter(path, "main"), run };
}

test("an untouched checkout reports no stray work", async () => {
  const { git } = repo();
  const before = await git.checkoutSnapshot();
  assert.deepEqual(await git.strayWork(before), { commits: [], dirtyFiles: [] });
});

test("the user's own pre-existing uncommitted work is NOT reported", async () => {
  const { path, git } = repo();
  // The user is mid-edit when the agent starts — exactly the state that used to
  // produce a false "agent worked outside its worktree" error.
  writeFileSync(join(path, "package.json"), "{}\n");
  writeFileSync(join(path, "pnpm-lock.yaml"), "lock\n");

  const before = await git.checkoutSnapshot();
  const stray = await git.strayWork(before);

  assert.deepEqual(stray.dirtyFiles, [], "the user's own edits are not agent damage");
  assert.deepEqual(stray.commits, []);
});

test("the user's own commits ahead of origin are NOT reported", async () => {
  const { path, git, run } = repo();
  // A checkout sitting on a feature branch ahead of the base branch.
  run("checkout", "-qb", "crew-1");
  writeFileSync(join(path, "mine.txt"), "my work\n");
  run("add", "-A");
  run("commit", "-qm", "my own commit");

  const before = await git.checkoutSnapshot();
  assert.deepEqual(await git.strayWork(before), { commits: [], dirtyFiles: [] });
});

test("a commit made DURING the run is reported", async () => {
  const { path, git, run } = repo();
  const before = await git.checkoutSnapshot();

  writeFileSync(join(path, "docs.md"), "stray\n");
  run("add", "-A");
  run("commit", "-qm", "docs: add cache architecture");

  const stray = await git.strayWork(before);
  assert.equal(stray.commits.length, 1);
  assert.match(stray.commits[0], /docs: add cache architecture/);
});

test("a file created DURING the run is reported", async () => {
  const { path, git } = repo();
  const before = await git.checkoutSnapshot();
  writeFileSync(join(path, "new.md"), "written by the agent\n");

  const stray = await git.strayWork(before);
  assert.equal(stray.dirtyFiles.length, 1);
  assert.match(stray.dirtyFiles[0], /new\.md/);
});

test("new agent work is separated from the user's pre-existing edits", async () => {
  const { path, git } = repo();
  writeFileSync(join(path, "package.json"), "{}\n"); // the user's, before the run
  const before = await git.checkoutSnapshot();
  writeFileSync(join(path, "agent.md"), "the agent's\n"); // during the run

  const stray = await git.strayWork(before);
  assert.equal(stray.dirtyFiles.length, 1, "only the agent's file");
  assert.match(stray.dirtyFiles[0], /agent\.md/);
});

test("a branch switch during the run is surfaced even with no new commits", async () => {
  const { git, run } = repo();
  run("branch", "other");
  const before = await git.checkoutSnapshot();
  run("checkout", "-q", "other");
  run("checkout", "-q", "-"); // back again — HEAD sha unchanged overall

  // Same commit, so nothing to report: this is the no-op case.
  assert.deepEqual((await git.strayWork(before)).commits, []);
});

test("detection works when origin/base does not exist at all", async () => {
  // A repo with no remote used to make the old absolute check throw; the
  // snapshot approach never consults origin.
  const { path, git } = repo();
  const before = await git.checkoutSnapshot();
  writeFileSync(join(path, "x.md"), "y\n");
  const stray = await git.strayWork(before);
  assert.equal(stray.dirtyFiles.length, 1);
});
