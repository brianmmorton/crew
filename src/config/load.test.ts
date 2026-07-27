import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./load.js";

/**
 * The `linear:` -> `tracker:` migration. Configs written before Jira support
 * must keep loading untouched, so these pin that behaviour rather than trusting
 * it to survive future edits to the schema.
 */

/**
 * Write a crew dir containing config.yaml + constitution.md, return its parent.
 *
 * The parent is a real git repo: loadConfig now infers the repo root from git
 * and rejects a config pointing anywhere else, so a bare temp dir would fail
 * validation before reaching the tracker logic these tests are about.
 */
function repoWith(configYaml: string, git = true): string {
  // realpath so the fixture path matches what git reports back on macOS, where
  // /var is a symlink to /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crew-cfg-")));
  const dir = join(root, ".crew");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), configYaml);
  writeFileSync(join(dir, "constitution.md"), "# constitution");
  if (git) {
    execFileSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  }
  return root;
}

const BODY = `
repo:
  path: "."
  baseBranch: main
`;

test("a legacy `linear:` block still loads, as provider linear", () => {
  const root = repoWith(`${BODY}
linear:
  team: "Brian"
  statuses:
    ready: "Todo"
`);
  const cfg = loadConfig(root);
  assert.equal(cfg.tracker.provider, "linear");
  assert.equal(cfg.tracker.team, "Brian");
  assert.equal(cfg.tracker.statuses.ready, "Todo");
});

test("the resolved config exposes only `tracker`, so the two can't drift", () => {
  const root = repoWith(`${BODY}
linear:
  team: "Brian"
`);
  const cfg = loadConfig(root) as unknown as Record<string, unknown>;
  assert.equal("linear" in cfg, false);
  assert.ok(cfg.tracker);
});

test("a `tracker:` block with provider jira loads with its jira defaults", () => {
  const root = repoWith(`${BODY}
tracker:
  provider: jira
  team: "BRI"
`);
  const cfg = loadConfig(root);
  assert.equal(cfg.tracker.provider, "jira");
  assert.equal(cfg.tracker.team, "BRI");
  // Defaults fill in so a minimal Jira config is valid.
  assert.equal(cfg.tracker.jira.issueTypes.bug, "Bug");
  assert.equal(cfg.tracker.jira.usePriority, true);
});

test("a `tracker:` block defaults to provider linear when unspecified", () => {
  const root = repoWith(`${BODY}
tracker:
  team: "Brian"
`);
  assert.equal(loadConfig(root).tracker.provider, "linear");
});

test("defining both `tracker:` and `linear:` is rejected", () => {
  const root = repoWith(`${BODY}
tracker:
  team: "A"
linear:
  team: "B"
`);
  assert.throws(
    () => loadConfig(root),
    (e: Error) => e instanceof ConfigError && e.message.includes("define only one"),
  );
});

test("omitting both is rejected, naming both accepted spellings", () => {
  const root = repoWith(BODY);
  assert.throws(
    () => loadConfig(root),
    (e: Error) =>
      e instanceof ConfigError &&
      e.message.includes("tracker") &&
      e.message.includes("linear"),
  );
});

test("an unknown provider is rejected rather than silently defaulting", () => {
  const root = repoWith(`${BODY}
tracker:
  provider: asana
  team: "X"
`);
  assert.throws(() => loadConfig(root), ConfigError);
});

/**
 * Repo discovery. The point of these is that a checkout describes itself —
 * crew should read the repo root, base branch and code host out of git rather
 * than trusting defaults that happen to be right in the common case.
 */

const TRACKER = `
tracker:
  team: "Brian"
`;

test("the crew dir is found by walking up, so commands work from a subdirectory", () => {
  const root = repoWith(`${BODY}${TRACKER}`);
  const nested = join(root, "src", "deep", "nested");
  mkdirSync(nested, { recursive: true });

  const cfg = loadConfig(nested);
  assert.equal(cfg.configDir, join(root, ".crew"));
  // repo.path is the git root, not the directory the command was run from.
  assert.equal(cfg.repo.path, root);
});

test("repo.path defaults to the git toplevel rather than the config dir's parent", () => {
  const root = repoWith(`${BODY}${TRACKER}`);
  assert.equal(loadConfig(root).repo.path, root);
});

test("a config outside any git repo is rejected with a clear message", () => {
  const root = repoWith(`${BODY}${TRACKER}`, false);
  assert.throws(
    () => loadConfig(root),
    (e: Error) => e instanceof ConfigError && e.message.includes("not a git repository"),
  );
});

test("a repo.path pointing at a missing directory is rejected at load time", () => {
  const root = repoWith(`
repo:
  path: "./does-not-exist"
${TRACKER}`);
  assert.throws(
    () => loadConfig(root),
    (e: Error) => e instanceof ConfigError && e.message.includes("does not exist"),
  );
});

test("baseBranch is inferred from origin/HEAD when left at the default", () => {
  const root = repoWith(`${BODY}${TRACKER}`);
  // Stand in for a clone: an origin remote whose HEAD points at `trunk`.
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/app.git"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], {
    stdio: "ignore",
  });

  assert.equal(loadConfig(root).repo.baseBranch, "trunk");
});

test("an explicitly configured baseBranch wins over what git reports", () => {
  const root = repoWith(`
repo:
  path: "."
  baseBranch: release
${TRACKER}`);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/app.git"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], {
    stdio: "ignore",
  });

  assert.equal(loadConfig(root).repo.baseBranch, "release");
});

test("a bitbucket origin sets the forge and the workspace/slug", () => {
  const root = repoWith(`${BODY}${TRACKER}`);
  execFileSync(
    "git",
    ["-C", root, "remote", "add", "origin", "git@bitbucket.org:my-workspace/my-repo.git"],
    { stdio: "ignore" },
  );

  const cfg = loadConfig(root);
  assert.equal(cfg.repo.forge, "bitbucket");
  assert.equal(cfg.repo.bitbucketRepo, "my-workspace/my-repo");
});

test("a github origin leaves the forge at github and sets no bitbucket slug", () => {
  const root = repoWith(`${BODY}${TRACKER}`);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:acme/app.git"], {
    stdio: "ignore",
  });

  const cfg = loadConfig(root);
  assert.equal(cfg.repo.forge, "github");
  assert.equal(cfg.repo.bitbucketRepo, undefined);
});

test("an explicit bitbucketRepo wins over the one derived from the remote", () => {
  const root = repoWith(`
repo:
  path: "."
  forge: "bitbucket"
  bitbucketRepo: "chosen/by-hand"
${TRACKER}`);
  execFileSync(
    "git",
    ["-C", root, "remote", "add", "origin", "git@bitbucket.org:from-remote/repo.git"],
    { stdio: "ignore" },
  );

  assert.equal(loadConfig(root).repo.bitbucketRepo, "chosen/by-hand");
});

test("CREW_REPO drives a sibling repo without cd-ing into it", () => {
  const root = repoWith(`${BODY}${TRACKER}`);
  const previous = process.env.CREW_REPO;
  process.env.CREW_REPO = root;
  try {
    // No startDir argument: the override is the whole point.
    assert.equal(loadConfig().repo.path, root);
  } finally {
    if (previous === undefined) delete process.env.CREW_REPO;
    else process.env.CREW_REPO = previous;
  }
});
