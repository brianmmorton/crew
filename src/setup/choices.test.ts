import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { AGENT_PRESETS, applyChoices, requiredEnvFor } from "./choices.js";
import { configSchema } from "../config/schema.js";
import type { SetupChoices } from "./choices.js";

/**
 * `applyChoices` edits config.yaml as text so the template's comments survive.
 * That makes it sensitive to the template's exact layout, so every case here
 * runs against the real shipped template and asserts the result still parses
 * as YAML and validates against the config schema — the two ways a bad regex
 * would show up in a user's repo rather than here.
 */

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../templates/agents/config.yaml", import.meta.url)),
  "utf8",
);

const preset = (name: string) => AGENT_PRESETS.find((p) => p.provider === name)!;

/** Apply, then parse + validate, returning the resolved config. */
function applied(choices: SetupChoices) {
  const out = applyChoices(TEMPLATE, choices);
  const parsed = parse(out); // throws on duplicate keys / broken indentation
  const result = configSchema.safeParse(parsed);
  assert.ok(
    result.success,
    `schema rejected the generated config: ${JSON.stringify(
      result.success ? [] : result.error.issues,
    )}`,
  );
  return { text: out, cfg: result.data! };
}

test("the shipped template is itself valid (guards the fixture)", () => {
  assert.ok(configSchema.safeParse(parse(TEMPLATE)).success);
});

test("linear + github + claude leaves the defaults in place", () => {
  const { cfg } = applied({
    tracker: "linear",
    forge: "github",
    agent: preset("claude"),
  });
  assert.equal(cfg.tracker!.provider, "linear");
  assert.equal(cfg.repo.forge, "github");
  assert.equal(cfg.agent.provider, "claude");
  // The built-in adapter needs no command block.
  assert.equal(cfg.agent.command, undefined);
});

test("jira + bitbucket + codex writes every choice through", () => {
  const { cfg } = applied({
    tracker: "jira",
    forge: "bitbucket",
    agent: preset("codex"),
    bitbucketRepo: "acme/widgets",
  });
  assert.equal(cfg.tracker!.provider, "jira");
  assert.equal(cfg.repo.forge, "bitbucket");
  assert.equal(cfg.repo.bitbucketRepo, "acme/widgets");
  assert.equal(cfg.agent.provider, "codex");
  assert.equal(cfg.agent.command, "codex");
  assert.deepEqual(cfg.agent.args, ["exec"]);
  assert.equal(cfg.agent.promptVia, "stdin");
  assert.equal(cfg.agent.modelFlag, "--model");
});

test("bitbucket without a slug leaves it unset, to be inferred from origin", () => {
  const { cfg } = applied({
    tracker: "linear",
    forge: "bitbucket",
    agent: preset("claude"),
  });
  assert.equal(cfg.repo.forge, "bitbucket");
  assert.equal(cfg.repo.bitbucketRepo, undefined);
});

test("applying choices is idempotent — no duplicate keys on a second pass", () => {
  const choices: SetupChoices = {
    tracker: "jira",
    forge: "bitbucket",
    agent: preset("codex"),
    bitbucketRepo: "acme/widgets",
  };
  const once = applyChoices(TEMPLATE, choices);
  const twice = applyChoices(once, choices);
  assert.equal(twice, once);
  assert.ok(configSchema.safeParse(parse(twice)).success);
});

test("switching providers on an already-configured file replaces, not appends", () => {
  const bitbucket = applyChoices(TEMPLATE, {
    tracker: "jira",
    forge: "bitbucket",
    agent: preset("codex"),
    bitbucketRepo: "acme/widgets",
  });
  const back = applyChoices(bitbucket, {
    tracker: "linear",
    forge: "github",
    agent: preset("claude"),
  });
  const cfg = configSchema.parse(parse(back)); // throws if a key was duplicated
  assert.equal(cfg.repo.forge, "github");
  assert.equal(cfg.tracker!.provider, "linear");
  assert.equal(cfg.agent.provider, "claude");
});

test("the template's explanatory comments survive the rewrite", () => {
  const { text } = applied({
    tracker: "jira",
    forge: "bitbucket",
    agent: preset("codex"),
  });
  // Comments are most of the template's value to someone editing it later.
  assert.match(text, /--- Issue tracker ---/);
  assert.match(text, /needs LINEAR_API_KEY/);
});

test("requiredEnvFor names only the chosen providers' credentials", () => {
  assert.deepEqual(
    requiredEnvFor({ tracker: "linear", forge: "github", agent: preset("claude") }),
    ["LINEAR_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  );
  assert.deepEqual(
    requiredEnvFor({ tracker: "jira", forge: "bitbucket", agent: preset("codex") }),
    [
      "JIRA_HOST",
      "JIRA_EMAIL",
      "JIRA_API_TOKEN",
      "BITBUCKET_USERNAME",
      "BITBUCKET_APP_PASSWORD",
    ],
  );
});
