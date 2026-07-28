import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { refreshAgentsDoc } from "./agentsDoc.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/agents", import.meta.url));

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "crew-agentsdoc-test-"));
}

test("refreshAgentsDoc writes the file when absent, stamped with the given version", () => {
  const dir = tmpConfigDir();
  try {
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "1.2.3");
    assert.equal(wrote, true);
    const content = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(content, /crew-generated: v1\.2\.3/);
    assert.doesNotMatch(content, /\{\{CREW_VERSION\}\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAgentsDoc is a no-op when already stamped with the current version", () => {
  const dir = tmpConfigDir();
  try {
    refreshAgentsDoc(dir, TEMPLATES_DIR, "1.2.3");
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "1.2.3");
    assert.equal(wrote, false);
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAgentsDoc regenerates when the installed crew version is newer", () => {
  const dir = tmpConfigDir();
  try {
    refreshAgentsDoc(dir, TEMPLATES_DIR, "1.2.3");
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "1.3.0");
    assert.equal(wrote, true);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /crew-generated: v1\.3\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAgentsDoc leaves a newer-stamped file alone (never downgrades)", () => {
  const dir = tmpConfigDir();
  try {
    refreshAgentsDoc(dir, TEMPLATES_DIR, "2.0.0");
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "1.9.9");
    assert.equal(wrote, false);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /crew-generated: v2\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAgentsDoc treats a version bump past two digits correctly (10 > 9)", () => {
  // A naive string compare would put "1.9.0" after "1.10.0" — this is the
  // regression a real integer-segment compare guards against.
  const dir = tmpConfigDir();
  try {
    refreshAgentsDoc(dir, TEMPLATES_DIR, "1.9.0");
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "1.10.0");
    assert.equal(wrote, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAgentsDoc regenerates an unstamped file (predates version tracking)", () => {
  const dir = tmpConfigDir();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# some old unstamped doc\n", "utf8");
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "1.0.0");
    assert.equal(wrote, true);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /crew-generated: v1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAgentsDoc always writes when the running version is unknown", () => {
  // packageVersion() falls back to "unknown" if package.json can't be read;
  // treating that as "always regenerate" is safer than treating it as
  // "never regenerate" (which would wedge in perpetuity).
  const dir = tmpConfigDir();
  try {
    refreshAgentsDoc(dir, TEMPLATES_DIR, "5.0.0");
    const wrote = refreshAgentsDoc(dir, TEMPLATES_DIR, "unknown");
    assert.equal(wrote, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generated doc documents every real config.yaml top-level section", () => {
  const dir = tmpConfigDir();
  try {
    refreshAgentsDoc(dir, TEMPLATES_DIR, "1.0.0");
    const doc = readFileSync(join(dir, "AGENTS.md"), "utf8");
    for (const key of [
      "project",
      "repo.path",
      "agent.provider",
      "mcpServers",
      "oauth",
      "tracker.provider",
      "budget.target",
      "worktrees.reuse",
      "gates.wipCap",
      "models.default",
      "personas.",
      "triager.cadence",
      "idle.enabled",
      "ui.logoUrl",
    ]) {
      assert.ok(doc.includes(key), `AGENTS.md doesn't mention "${key}"`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("throws rather than silently no-op when configDir doesn't exist yet", () => {
  const parent = tmpConfigDir();
  const dir = join(parent, "nested", "crew-dir-does-not-exist-yet");
  try {
    assert.throws(() => refreshAgentsDoc(dir, TEMPLATES_DIR, "1.0.0"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
