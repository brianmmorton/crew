import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAdapter } from "../git/git.js";
import { diagnose, formatProbe, verifyInWorktree, type ProbeStep } from "./probe.js";
import type { CrewConfig } from "../types.js";

/**
 * A repo whose working checkout carries an UNTRACKED file — the essential
 * shape of the bug this probe exists to catch. `generated.txt` stands in for a
 * generated Prisma client / codegen output / build artifact: real on the
 * developer's disk, gitignored, and therefore absent from any fresh worktree.
 */
function repo(): { path: string; git: GitAdapter } {
  const root = mkdtempSync(join(tmpdir(), "crew-probe-"));
  const path = join(root, "myrepo");
  execFileSync("git", ["init", "-q", path]);
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  run("config", "user.email", "t@t.co");
  run("config", "user.name", "T");
  writeFileSync(join(path, ".gitignore"), "generated.txt\n");
  writeFileSync(join(path, "a.txt"), "base\n");
  run("add", "-A");
  run("commit", "-qm", "base");
  run("branch", "-M", "main");
  run("remote", "add", "origin", path);
  run("fetch", "-q", "origin");
  // Present in the warm checkout only — never committed.
  writeFileSync(join(path, "generated.txt"), "generated\n");
  return { path, git: new GitAdapter(path, "main") };
}

function config(path: string, gates: Partial<CrewConfig["gates"]>): CrewConfig {
  return {
    gates: { verify: {}, noTouch: [], wipCap: 3, ...gates },
    repo: { path, baseBranch: "main" },
  } as unknown as CrewConfig;
}

const quiet = () => {};

test("a command depending on an untracked file passes in the checkout but fails in the probe", async () => {
  const { path, git } = repo();
  // Exactly the failure mode from the ScoutSense runs: works by hand, fails
  // for every agent, because the file it needs was never tracked by git.
  const cmd = "cat generated.txt";

  assert.doesNotThrow(
    () => execFileSync("sh", ["-c", cmd], { cwd: path }),
    "precondition: the command works in the warm checkout",
  );

  const res = await verifyInWorktree(config(path, { verify: { app: cmd } }), git, quiet);
  assert.equal(res.ok, false, "the probe must catch what the warm checkout hides");
  assert.equal(res.steps[0].status, "failed");
});

test("a command using only tracked files passes", async () => {
  const { path, git } = repo();
  const res = await verifyInWorktree(config(path, { verify: { app: "cat a.txt" } }), git, quiet);
  assert.equal(res.ok, true, formatProbe(res));
  assert.equal(res.steps[0].status, "passed");
});

test("each app is reported separately rather than short-circuiting at the first failure", async () => {
  const { path, git } = repo();
  // A real cycle chains these with `&&`, which would hide `web` entirely. The
  // probe's job is to tell the user which of their commands are cold-safe.
  const res = await verifyInWorktree(
    config(path, { verify: { api: "exit 1", web: "cat a.txt" } }),
    git,
    quiet,
  );
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.steps.map((s) => [s.app, s.status]),
    [
      ["api", "failed"],
      ["web", "passed"],
    ],
  );
});

test("setup runs first, and its env carries into each verify command", async () => {
  const { path, git } = repo();
  // setup and verify run in separate shells, so an exported var only survives
  // if the probe re-applies setup per command — as a real cycle's single
  // joined shell would.
  const res = await verifyInWorktree(
    config(path, {
      setup: "export CREW_PROBE_VAR=ok",
      verify: { app: 'test "$CREW_PROBE_VAR" = ok' },
    }),
    git,
    quiet,
  );
  assert.equal(res.ok, true, formatProbe(res));
});

test("a failing setup skips the verify commands instead of reporting them as failures", async () => {
  const { path, git } = repo();
  const res = await verifyInWorktree(
    config(path, { setup: "exit 3", verify: { api: "true", web: "true" } }),
    git,
    quiet,
  );
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.steps.map((s) => [s.app, s.status]),
    [
      ["setup", "failed"],
      ["api", "skipped"],
      ["web", "skipped"],
    ],
  );
});

test("the probe worktree is removed even when the checks fail", async () => {
  const { path, git } = repo();
  await verifyInWorktree(config(path, { verify: { app: "exit 1" } }), git, quiet);
  const wt = await git.findWorktree("crew/probe-verify");
  assert.equal(wt, null, "a stranded worktree would block the next probe");
});

test("no verify commands is reported as nothing to prove, not as a pass", async () => {
  const { path, git } = repo();
  const res = await verifyInWorktree(config(path, { verify: {} }), git, quiet);
  assert.equal(res.steps.length, 0);
  assert.match(res.error ?? "", /no verify commands/);
});

test("the probe does not disturb the main checkout's untracked files", async () => {
  const { path, git } = repo();
  await verifyInWorktree(config(path, { verify: { app: "cat a.txt" } }), git, quiet);
  assert.ok(existsSync(join(path, "generated.txt")), "the user's own files are untouched");
});

test("an ungenerated Prisma client is diagnosed as a missing generate step", () => {
  const step: ProbeStep = {
    app: "api",
    command: "tsc --noEmit",
    status: "failed",
    // Verbatim from the ScoutSense failure logs.
    output:
      "src/prismaClient.ts(1,10): error TS2305: Module '\"@prisma/client\"' has no exported member 'PrismaClient'.\n",
  };
  const why = diagnose(step);
  assert.match(why ?? "", /prisma generate/);
  // The output must name the real cause, not the symptom, or the user is left
  // reading a wall of TypeScript errors that blame their source code.
  assert.match(why ?? "", /not tracked by git|node_modules/);
});

test("a missing binary is diagnosed as a PATH problem", () => {
  const why = diagnose({
    app: "api",
    command: "pnpm test",
    status: "failed",
    output: "sh: pnpm: command not found\n",
  });
  assert.match(why ?? "", /PATH/);
  assert.match(why ?? "", /gates\.setup/);
});

test("an unrecognized failure yields no diagnosis rather than a wrong one", () => {
  const why = diagnose({
    app: "api",
    command: "jest",
    status: "failed",
    output: "FAIL src/sum.test.ts\n  expected 3, got 4\n",
  });
  assert.equal(why, undefined, "a genuine test failure must not be mislabeled as an env problem");
});

test("the summary marks each app and surfaces the diagnosis", () => {
  const out = formatProbe({
    ok: false,
    steps: [
      { app: "setup", command: "pnpm i", status: "passed", output: "" },
      {
        app: "api",
        command: "tsc",
        status: "failed",
        output: "error TS2305: Module '\"@prisma/client\"' has no exported member 'User'.",
      },
      { app: "web", command: "tsc", status: "skipped", output: "" },
    ],
  });
  assert.match(out, /✓ setup/);
  assert.match(out, /✗ api/);
  assert.match(out, /○ web/);
  assert.match(out, /prisma generate/);
});
