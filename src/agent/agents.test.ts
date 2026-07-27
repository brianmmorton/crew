import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentError,
  allClaims,
  agentsOfKind,
  discoverPersonaFiles,
  executorFor,
  isValidAgentName,
  loadAgents,
  orphanedConfigEntries,
  scheduledAgents,
  splitFrontmatter,
} from "./agents.js";
import type { AgentDef, CrewConfig, PersonaConfig } from "../types.js";

/** Minimal CrewConfig backed by a temp dir with the given persona files. */
function fixture(
  files: Record<string, string>,
  personas: Record<string, PersonaConfig> = {},
  mcpServers: Record<string, unknown> = {},
): CrewConfig {
  const dir = mkdtempSync(join(tmpdir(), "crew-agents-"));
  mkdirSync(join(dir, "personas"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, "personas", `${name}.md`), body, "utf8");
  }
  return { configDir: dir, personas, mcpServers } as unknown as CrewConfig;
}

// ----------------------------- frontmatter ---------------------------------

test("splitFrontmatter separates YAML from the prompt body", () => {
  const { data, body } = splitFrontmatter("---\nkind: reviewer\n---\nBe strict.\n");
  assert.equal(data.kind, "reviewer");
  assert.equal(body, "Be strict.\n");
});

test("splitFrontmatter leaves a body with no frontmatter untouched", () => {
  const src = "You are the QA persona.\n";
  const { data, body } = splitFrontmatter(src);
  assert.deepEqual(data, {});
  assert.equal(body, src);
});

test("splitFrontmatter treats malformed YAML as prose, not an error", () => {
  const src = "---\nkind: [unclosed\n---\nbody\n";
  const { data, body } = splitFrontmatter(src);
  assert.deepEqual(data, {});
  assert.equal(body, src);
});

test("splitFrontmatter ignores a --- that is not at the start", () => {
  const src = "intro\n---\nkind: reviewer\n---\n";
  const { data } = splitFrontmatter(src);
  assert.deepEqual(data, {});
});

// ----------------------------- discovery -----------------------------------

test("discoverPersonaFiles finds .md files and ignores everything else", () => {
  const cfg = fixture({ qa: "a", "my-agent": "b" });
  writeFileSync(join(cfg.configDir, "personas", "notes.txt"), "x");
  assert.deepEqual(discoverPersonaFiles(cfg), ["my-agent", "qa"]);
});

test("discoverPersonaFiles returns empty when the dir is missing", () => {
  const cfg = { configDir: join(tmpdir(), "crew-nope-xyz"), personas: {} } as CrewConfig;
  assert.deepEqual(discoverPersonaFiles(cfg), []);
});

test("a custom persona file with no config at all is a valid proposer", () => {
  const agents = loadAgents(fixture({ "perf-watch": "Watch performance.\n" }));
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "perf-watch");
  assert.equal(agents[0].kind, "proposer");
  assert.equal(agents[0].builtin, false);
  assert.equal(agents[0].prompt, "Watch performance.\n");
});

test("built-ins keep their historical kinds without any config", () => {
  const agents = loadAgents(fixture({ implementer: "x", qa: "y", architect: "z" }));
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  assert.equal(byName.implementer.kind, "executor");
  assert.equal(byName.qa.kind, "proposer");
  assert.equal(byName.architect.kind, "proposer");
  assert.ok(byName.qa.builtin);
});

test("an executor defaults to a continuous cadence", () => {
  const agents = loadAgents(fixture({ implementer: "x" }));
  assert.equal(agents[0].cadence, "continuous");
});

// ----------------------------- merging -------------------------------------

test("config.yaml overrides frontmatter", () => {
  const cfg = fixture(
    { "sec-review": "---\nkind: proposer\nmodel: haiku\n---\nbody\n" },
    { "sec-review": { model: "opus" } },
  );
  const [a] = loadAgents(cfg);
  assert.equal(a.model, "opus");
  assert.equal(a.kind, "proposer"); // untouched by the override
});

test("frontmatter alone configures an agent fully", () => {
  const cfg = fixture({
    docs: [
      "---",
      "kind: executor",
      "model: sonnet",
      "description: Writes docs",
      "claims: [type:docs]",
      "---",
      "prompt",
    ].join("\n"),
  });
  const [a] = loadAgents(cfg);
  assert.equal(a.kind, "executor");
  assert.equal(a.model, "sonnet");
  assert.equal(a.description, "Writes docs");
  assert.deepEqual(a.claims, ["type:docs"]);
});

test("an undefined field in config.yaml does not clobber frontmatter", () => {
  const cfg = fixture(
    { qa: "---\nmodel: haiku\n---\nbody\n" },
    { qa: { cadence: "0 9 * * 1" } },
  );
  const [a] = loadAgents(cfg);
  assert.equal(a.model, "haiku");
  assert.equal(a.cadence, "0 9 * * 1");
});

// ----------------------------- mcp grants ----------------------------------

test("a persona with no mcp key is granted no tools", () => {
  // The default is deliberate: tools are never inherited from the user's global
  // agent config, so a run's capabilities depend only on crew's own config.
  const [a] = loadAgents(fixture({ qa: "body\n" }));
  assert.equal(a.mcp, undefined);
});

const SERVERS = { sentry: { command: "npx" }, posthog: { command: "npx" } };

test("mcp grants are read from frontmatter", () => {
  const cfg = fixture({ qa: "---\nmcp: [sentry, posthog]\n---\nbody\n" }, {}, SERVERS);
  const [a] = loadAgents(cfg);
  assert.deepEqual(a.mcp, ["sentry", "posthog"]);
});

test("config.yaml mcp grants override frontmatter", () => {
  const cfg = fixture({ qa: "---\nmcp: [sentry]\n---\nbody\n" }, { qa: { mcp: ["posthog"] } }, SERVERS);
  const [a] = loadAgents(cfg);
  assert.deepEqual(a.mcp, ["posthog"]);
});

test("config.yaml can revoke a frontmatter grant with an empty list", () => {
  // Distinct from omitting the key: an explicit [] is how a project turns off a
  // shared persona file's tools without editing that file.
  const cfg = fixture({ qa: "---\nmcp: [sentry]\n---\nbody\n" }, { qa: { mcp: [] } }, SERVERS);
  const [a] = loadAgents(cfg);
  assert.deepEqual(a.mcp, []);
});

test("a frontmatter grant naming an undefined server is a loud error", () => {
  // Regression: validating only config.yaml missed this, so a typo failed open —
  // the agent ran, filed nothing, and repeated on every cadence with no cause
  // visible anywhere.
  const cfg = fixture({ qa: "---\nmcp: [sentr]\n---\nbody\n" }, {}, SERVERS);
  assert.throws(() => loadAgents(cfg), AgentError);
});

test("a config.yaml grant naming an undefined server is a loud error", () => {
  const cfg = fixture({ qa: "body\n" }, { qa: { mcp: ["nope"] } }, SERVERS);
  assert.throws(() => loadAgents(cfg), AgentError);
});

test("a grant revoked in config.yaml is not validated against the bad frontmatter name", () => {
  // The check runs on the merged value, so overriding a stale grant fixes it
  // without editing the shared persona file.
  const cfg = fixture({ qa: "---\nmcp: [gone]\n---\nbody\n" }, { qa: { mcp: [] } }, SERVERS);
  assert.doesNotThrow(() => loadAgents(cfg));
});

// ----------------------------- validation ----------------------------------

test("an invalid kind is a loud error, not a silent default", () => {
  const cfg = fixture({ bad: "---\nkind: destroyer\n---\nx" });
  assert.throws(() => loadAgents(cfg), AgentError);
});

test("an invalid allowedTypes entry is rejected", () => {
  const cfg = fixture({ bad: "---\nallowedTypes: [bug, nonsense]\n---\nx" });
  assert.throws(() => loadAgents(cfg), /allowedTypes/);
});

test("a non-positive maxProposals is rejected", () => {
  const cfg = fixture({ bad: "---\nmaxProposals: 0\n---\nx" });
  assert.throws(() => loadAgents(cfg), /maxProposals/);
});

test("isValidAgentName accepts kebab-case and rejects unsafe names", () => {
  assert.ok(isValidAgentName("qa"));
  assert.ok(isValidAgentName("security-review"));
  assert.ok(!isValidAgentName("../escape"));
  assert.ok(!isValidAgentName("Has Caps"));
  assert.ok(!isValidAgentName("-leading"));
  assert.ok(!isValidAgentName("a"));
});

test("a file whose name is unsafe is skipped, not loaded", () => {
  // Names with spaces/underscores/caps can't be typed as a CLI arg reliably.
  const cfg = fixture({ "my agent": "x", my_agent: "y", qa: "z" });
  assert.deepEqual(discoverPersonaFiles(cfg), ["qa"]);
});

test("orphanedConfigEntries flags config with no persona file", () => {
  const cfg = fixture({ qa: "x" }, { qa: {}, typo: { cadence: "0 9 * * 1" } });
  assert.deepEqual(orphanedConfigEntries(cfg), ["typo"]);
});

// ----------------------------- selection -----------------------------------

const mk = (name: string, kind: AgentDef["kind"], extra: Partial<AgentDef> = {}): AgentDef => ({
  name,
  kind,
  prompt: "",
  cadence: kind === "executor" ? "continuous" : "0 9 * * 1",
  builtin: false,
  ...extra,
});

test("scheduledAgents excludes executors and cadence-less agents", () => {
  const agents = [
    mk("qa", "proposer"),
    mk("implementer", "executor"),
    mk("idle", "proposer", { cadence: "" }),
  ];
  assert.deepEqual(scheduledAgents(agents).map((a) => a.name), ["qa"]);
});

test("agentsOfKind filters by kind", () => {
  const agents = [mk("qa", "proposer"), mk("sec", "reviewer")];
  assert.deepEqual(agentsOfKind(agents, "reviewer").map((a) => a.name), ["sec"]);
});

test("executorFor routes a labeled item to the executor that claims it", () => {
  const agents = [
    mk("implementer", "executor"),
    mk("docs-writer", "executor", { claims: ["type:docs"] }),
  ];
  assert.equal(executorFor(agents, ["type:docs"])?.name, "docs-writer");
});

test("executorFor falls back to the implementer for unclaimed work", () => {
  const agents = [
    mk("implementer", "executor"),
    mk("docs-writer", "executor", { claims: ["type:docs"] }),
  ];
  assert.equal(executorFor(agents, ["type:bug"])?.name, "implementer");
});

test("executorFor is deterministic when two executors claim the same label", () => {
  const agents = [
    mk("zebra", "executor", { claims: ["type:docs"] }),
    mk("alpha", "executor", { claims: ["type:docs"] }),
  ];
  assert.equal(executorFor(agents, ["type:docs"])?.name, "alpha");
});

test("executorFor uses a lone unclaimed executor when there is no implementer", () => {
  const agents = [mk("solo", "executor")];
  assert.equal(executorFor(agents, ["type:bug"])?.name, "solo");
});

test("executorFor returns null when no executor exists", () => {
  assert.equal(executorFor([mk("qa", "proposer")], ["type:bug"]), null);
});

test("executorFor ignores proposers and reviewers that share a claim label", () => {
  const agents = [
    mk("sec", "reviewer", { claims: ["type:bug"] }),
    mk("implementer", "executor"),
  ];
  assert.equal(executorFor(agents, ["type:bug"])?.name, "implementer");
});

test("allClaims collects every claimed label across executors", () => {
  const agents = [
    mk("a", "executor", { claims: ["type:docs"] }),
    mk("b", "executor", { claims: ["type:docs", "area:infra"] }),
  ];
  assert.deepEqual(allClaims(agents).sort(), ["area:infra", "type:docs"]);
});
