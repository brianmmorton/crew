import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  McpError,
  interpolate,
  materializeMcpConfig,
  pinnedToolsFor,
  referencedVars,
  resolveMcpForPersona,
  validateMcpServers,
} from "./mcp.js";
import type { McpServerConfig } from "../types.js";

const SENTRY: McpServerConfig = {
  command: "npx",
  args: ["-y", "@sentry/mcp-server@latest"],
  env: { SENTRY_AUTH_TOKEN: "${SENTRY_AUTH_TOKEN}" },
};

// ----------------------------- interpolation --------------------------------

test("interpolate substitutes a set variable", () => {
  const missing: string[] = [];
  assert.equal(interpolate("${TOK}", { TOK: "secret" }, missing), "secret");
  assert.deepEqual(missing, []);
});

test("interpolate records an unset variable instead of emptying it silently", () => {
  const missing: string[] = [];
  assert.equal(interpolate("${TOK}", {}, missing), "");
  assert.deepEqual(missing, ["TOK"]);
});

test("interpolate treats an empty value as unset", () => {
  // An exported-but-blank var is the classic half-configured .env, and it fails
  // identically to being absent — so it must be reported the same way.
  const missing: string[] = [];
  interpolate("${TOK}", { TOK: "" }, missing);
  assert.deepEqual(missing, ["TOK"]);
});

test("interpolate honours a :- default and does not report it missing", () => {
  const missing: string[] = [];
  assert.equal(interpolate("${HOST:-localhost}", {}, missing), "localhost");
  assert.deepEqual(missing, []);
});

test("interpolate handles several placeholders in one string", () => {
  const missing: string[] = [];
  const out = interpolate("https://${HOST}/api/${VER}", { HOST: "x.io", VER: "v2" }, missing);
  assert.equal(out, "https://x.io/api/v2");
});

test("interpolate leaves a literal with no placeholder untouched", () => {
  const missing: string[] = [];
  assert.equal(interpolate("npx", {}, missing), "npx");
  assert.deepEqual(missing, []);
});

test("interpolate does not report the same missing variable twice", () => {
  const missing: string[] = [];
  interpolate("${A}-${A}", {}, missing);
  assert.deepEqual(missing, ["A"]);
});

// ----------------------------- referencedVars -------------------------------

test("referencedVars finds variables across env, args, and headers", () => {
  const vars = referencedVars({
    command: "${BIN}",
    args: ["--flag", "${ARG}"],
    env: { A: "${ENV_A}" },
    headers: { Authorization: "Bearer ${TOKEN}" },
  });
  assert.deepEqual(vars.sort(), ["ARG", "BIN", "ENV_A", "TOKEN"]);
});

test("referencedVars skips placeholders that carry a default", () => {
  assert.deepEqual(referencedVars({ url: "${HOST:-localhost}" }), []);
});

// ----------------------------- resolution -----------------------------------

test("resolveMcpForPersona returns null when the persona was granted nothing", async () => {
  // The default: no key means no tools, never an inherited global config.
  assert.equal(await resolveMcpForPersona(undefined, { sentry: SENTRY }), null);
  assert.equal(await resolveMcpForPersona([], { sentry: SENTRY }), null);
});

test("resolveMcpForPersona grants only the named servers", async () => {
  const servers = { sentry: SENTRY, other: { command: "other" } };
  const out = await resolveMcpForPersona(["sentry"], servers, { SENTRY_AUTH_TOKEN: "t" });
  assert.deepEqual(out?.names, ["sentry"]);
  assert.deepEqual(Object.keys(out!.document.mcpServers), ["sentry"]);
});

test("resolveMcpForPersona interpolates secrets into the resolved document", async () => {
  const out = await resolveMcpForPersona(["sentry"], { sentry: SENTRY }, { SENTRY_AUTH_TOKEN: "tok-123" });
  const resolved = out!.document.mcpServers.sentry as { env: Record<string, string> };
  assert.equal(resolved.env.SENTRY_AUTH_TOKEN, "tok-123");
  assert.deepEqual(out!.missingVars, []);
});

test("resolveMcpForPersona reports missing credentials rather than resolving them blank", async () => {
  const out = await resolveMcpForPersona(["sentry"], { sentry: SENTRY }, {});
  assert.deepEqual(out?.missingVars, ["SENTRY_AUTH_TOKEN"]);
});

test("resolveMcpForPersona throws on a grant naming an undefined server", async () => {
  await assert.rejects(() => resolveMcpForPersona(["nope"], { sentry: SENTRY }), McpError);
});

test("resolveMcpForPersona keeps url servers and their headers", async () => {
  const out = await resolveMcpForPersona(
    ["analytics"],
    { analytics: { url: "https://mcp.example.com", type: "http", headers: { Authorization: "Bearer ${K}" } } },
    { K: "abc" },
  );
  const resolved = out!.document.mcpServers.analytics as Record<string, unknown>;
  assert.equal(resolved.url, "https://mcp.example.com");
  assert.equal(resolved.type, "http");
  assert.deepEqual(resolved.headers, { Authorization: "Bearer abc" });
});

test("resolveMcpForPersona reports an oauth failure rather than resolving without auth", async () => {
  const out = await resolveMcpForPersona(
    ["secured"],
    {
      secured: {
        url: "https://mcp.example.com",
        oauth: {
          authorizationUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          clientId: "abc",
        },
      },
    },
    {},
  );
  assert.equal(out?.oauthErrors.length, 1);
  assert.match(out!.oauthErrors[0], /no stored token for "secured"/);
  const resolved = out!.document.mcpServers.secured as Record<string, unknown>;
  assert.equal(resolved.headers, undefined);
});

// ----------------------------- materialization ------------------------------

test("materializeMcpConfig writes a private file and cleans it up", () => {
  const { path, cleanup } = materializeMcpConfig({ mcpServers: { a: { command: "x" } } });
  assert.ok(existsSync(path));
  // The file holds interpolated secrets, so it must not be world-readable.
  assert.equal(statSync(path).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { a: { command: "x" } } });
  cleanup();
  assert.equal(existsSync(path), false);
});

test("materializeMcpConfig writes outside the working tree", () => {
  // A resolved config inside the repo could be committed by the very agent we
  // hand it to, so it has to live in the OS temp dir.
  const { path, cleanup } = materializeMcpConfig({ mcpServers: {} });
  assert.ok(!path.startsWith(process.cwd()));
  cleanup();
});

test("cleanup is safe to call twice", () => {
  const { cleanup } = materializeMcpConfig({ mcpServers: {} });
  cleanup();
  assert.doesNotThrow(() => cleanup());
});

// ----------------------------- validation -----------------------------------

test("validateMcpServers requires a transport", () => {
  assert.throws(() => validateMcpServers({ bad: {} }), McpError);
});

test("validateMcpServers rejects defining both transports", () => {
  assert.throws(() => validateMcpServers({ bad: { command: "x", url: "https://y" } }), McpError);
});

test("validateMcpServers accepts a well-formed server with no warnings", () => {
  assert.deepEqual(validateMcpServers({ sentry: SENTRY }), []);
});

test("validateMcpServers warns about a literal secret in a committed file", () => {
  const warnings = validateMcpServers({
    sentry: { command: "npx", env: { TOKEN: "sk-abcdefghijklmnopqrstuvwxyz012345" } },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /literal secret/);
});

test("validateMcpServers warns when a granted tool can write to the tracker", () => {
  // The engine owns tracker writes so dedup and the PRD gate can't be bypassed.
  const warnings = validateMcpServers({
    linear: { command: "npx", allowedTools: ["create_issue"] },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bypass dedup/);
});

test("validateMcpServers does not warn about read-only tracker tools", () => {
  assert.deepEqual(validateMcpServers({ linear: { command: "npx", allowedTools: ["list_issues"] } }), []);
});

test("validateMcpServers scans many servers without regex state leaking between them", () => {
  // The placeholder pattern carries /g, so a shared instance would let one
  // server's .test() advance lastIndex into the next server's scan.
  const many = Object.fromEntries(
    ["a", "b", "c", "d"].map((n) => [n, { command: "npx", env: { T: `\${TOKEN_${n}}` } }]),
  );
  assert.deepEqual(validateMcpServers(many), []);

  // A real literal is still caught when it sits between placeholder servers.
  const mixed = validateMcpServers({
    a: { command: "npx", env: { T: "${TOKEN_A}" } },
    b: { command: "npx", env: { T: "sk-abcdefghijklmnopqrstuvwxyz012345" } },
    c: { command: "npx", env: { T: "${TOKEN_C}" } },
  });
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /mcpServers\.b/);
});

test("validating a server does not corrupt later placeholder scans", () => {
  // Regression, and the symptom is remote from the cause. On a value holding a
  // placeholder, `!PLACEHOLDER.test(v) && ...` matches — advancing lastIndex —
  // and short-circuits past any reset written after it. A shared /g regex then
  // carries that offset into the NEXT matchAll, which starts mid-string and
  // silently reports zero variables, so `crew doctor` calls a server fully
  // configured when its token is absent.
  validateMcpServers({ alpha: { command: "npx", env: { T: "${TOKEN_A}" } } });
  assert.deepEqual(referencedVars({ command: "npx", env: { T: "${TOKEN_A}" } }), ["TOKEN_A"]);

  // Same hazard on the throw path, where a reset placed after the loop is skipped.
  assert.throws(
    () =>
      validateMcpServers({
        alpha: { command: "npx", env: { T: "${TOKEN_A}" } },
        zulu: {}, // no transport → throws before any later cleanup
      }),
    McpError,
  );
  assert.deepEqual(referencedVars({ command: "npx", env: { T: "${TOKEN_B}" } }), ["TOKEN_B"]);
});

// ----------------------------- pinned tools ---------------------------------

test("pinnedToolsFor namespaces bare tool names", () => {
  const out = pinnedToolsFor(["sentry"], { sentry: { ...SENTRY, allowedTools: ["find_errors"] } });
  assert.deepEqual(out, ["mcp__sentry__find_errors"]);
});

test("pinnedToolsFor leaves already-namespaced names alone", () => {
  const out = pinnedToolsFor(["sentry"], { sentry: { ...SENTRY, allowedTools: ["mcp__sentry__x"] } });
  assert.deepEqual(out, ["mcp__sentry__x"]);
});

test("pinnedToolsFor returns null when nothing is pinned", () => {
  // Null means there is no restriction worth stating in the prompt.
  assert.equal(pinnedToolsFor(["sentry"], { sentry: SENTRY }), null);
  assert.equal(pinnedToolsFor(undefined, { sentry: SENTRY }), null);
});

test("pinnedToolsFor keeps an unpinned server available via a wildcard", () => {
  // Mixing a pinned and an unpinned grant must not read as "the unpinned server
  // was excluded" — that would silently revoke a server the user left open.
  const out = pinnedToolsFor(["sentry", "analytics"], {
    sentry: { ...SENTRY, allowedTools: ["find_errors"] },
    analytics: { url: "https://a.example" },
  });
  assert.deepEqual(out, ["mcp__sentry__find_errors", "mcp__analytics__*"]);
});
