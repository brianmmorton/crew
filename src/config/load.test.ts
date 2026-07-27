import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "./load.js";

/**
 * The `linear:` -> `tracker:` migration. Configs written before Jira support
 * must keep loading untouched, so these pin that behaviour rather than trusting
 * it to survive future edits to the schema.
 */

/** Write a crew dir containing config.yaml + constitution.md, return its parent. */
function repoWith(configYaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "crew-cfg-"));
  const dir = join(root, ".crew");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.yaml"), configYaml);
  writeFileSync(join(dir, "constitution.md"), "# constitution");
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
