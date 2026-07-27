/**
 * Per-persona MCP tooling.
 *
 * Agents are stateless workers (see types.ts), so anything they learn from the
 * outside world has to arrive through the prompt or through a tool. This module
 * covers the tool half: a persona can be granted named MCP servers — Sentry,
 * analytics, a docs index — and gets exactly those, nothing else.
 *
 * Two rules shape the design:
 *
 *  1. **Secrets are referenced, never written.** `config.yaml` is committed, so
 *     it may only ever hold `${SENTRY_AUTH_TOKEN}`. The value is resolved from
 *     the environment (see util/env.ts) at spawn time, into a file outside the
 *     repo that is deleted when the run ends.
 *
 *  2. **Grants are explicit.** A persona with no `mcp:` key gets no servers at
 *     all. Crew always spawns with the equivalent of `--strict-mcp-config`, so
 *     a run's tools are a function of crew's config alone — never of whatever
 *     the user happens to have configured globally in Claude Code or Codex.
 *     That keeps a run reproducible on someone else's machine.
 *
 * Deliberately NOT solved here: writing to the tracker. Personas return typed
 * proposals that the engine dedups, gates, and files. An MCP server that could
 * create issues directly would route around `allowedTypes`, `maxProposals`, and
 * the PRD approval gate, so tracker-write servers are rejected at validation.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../types.js";

/** Thrown for a malformed or unsafe MCP block; surfaced by `crew doctor`. */
export class McpError extends Error {}

/**
 * `${VAR}` placeholders, optionally with a `:-default` suffix — the shell's own
 * spelling, since that is what users already expect from docker-compose and
 * `.mcp.json`. A literal value with no placeholder is passed through untouched.
 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * A fresh copy of the placeholder pattern.
 *
 * `PLACEHOLDER` carries `/g`, which makes `.test()` and `.matchAll()` stateful
 * through `lastIndex` — and a throw between a `.test()` and its reset would
 * strand that state on the shared module-level regex, silently skipping matches
 * in every later call. Allocating per use costs nothing here and makes the
 * hazard structurally impossible rather than something to remember.
 */
function placeholderRe(): RegExp {
  return new RegExp(PLACEHOLDER.source, "g");
}

/**
 * Substitute `${VAR}` from `env`. Unset variables with no default are reported
 * rather than silently becoming "" — an MCP server that starts with an empty
 * token fails deep inside the agent run with an opaque 401, which is a
 * miserable thing to debug from a cron log.
 */
export function interpolate(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: string[],
): string {
  return value.replace(placeholderRe(), (_m, name: string, fallback?: string) => {
    const found = env[name];
    if (found !== undefined && found !== "") return found;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return "";
  });
}

/** Every `${VAR}` a server definition depends on, for `crew doctor`. */
export function referencedVars(server: McpServerConfig): string[] {
  const out: string[] = [];
  const scan = (s: string): void => {
    for (const m of s.matchAll(placeholderRe())) {
      if (m[2] === undefined && !out.includes(m[1])) out.push(m[1]);
    }
  };
  if (server.command) scan(server.command);
  if (server.url) scan(server.url);
  for (const a of server.args ?? []) scan(a);
  for (const v of Object.values(server.env ?? {})) scan(v);
  for (const v of Object.values(server.headers ?? {})) scan(v);
  return out;
}

/**
 * Resolve one server definition against the environment. Returns the wire shape
 * Claude Code's `--mcp-config` expects, plus any variables that were missing.
 */
function resolveServer(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv,
  missing: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Transport is implied by shape: `command` = stdio, `url` = http/sse. Claude
  // Code infers the same way, so we pass through rather than inventing a key.
  if (server.command) {
    out.command = interpolate(server.command, env, missing);
    out.args = (server.args ?? []).map((a) => interpolate(a, env, missing));
  }
  if (server.url) {
    out.url = interpolate(server.url, env, missing);
    if (server.type) out.type = server.type;
  }
  if (server.env) {
    out.env = Object.fromEntries(
      Object.entries(server.env).map(([k, v]) => [k, interpolate(v, env, missing)]),
    );
  }
  if (server.headers) {
    out.headers = Object.fromEntries(
      Object.entries(server.headers).map(([k, v]) => [k, interpolate(v, env, missing)]),
    );
  }
  return out;
}

export interface ResolvedMcp {
  /** The `{ mcpServers: {...} }` document to hand the agent CLI. */
  document: { mcpServers: Record<string, unknown> };
  /** Server names that were granted, in config order. */
  names: string[];
  /** `${VAR}`s with no value and no default — the run should be skipped. */
  missingVars: string[];
}

/**
 * Build the MCP document for one persona: the named servers it was granted,
 * with environment variables resolved.
 *
 * Returns `null` when the persona was granted nothing, which is the default and
 * means "spawn with no MCP config at all".
 */
export function resolveMcpForPersona(
  grants: string[] | undefined,
  servers: Record<string, McpServerConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcp | null {
  if (!grants || grants.length === 0) return null;

  const missingVars: string[] = [];
  const mcpServers: Record<string, unknown> = {};
  const names: string[] = [];

  for (const name of grants) {
    const def = servers[name];
    if (!def) {
      throw new McpError(
        `unknown MCP server "${name}" — define it under \`mcpServers:\` in config.yaml ` +
          `(known: ${Object.keys(servers).join(", ") || "none"})`,
      );
    }
    mcpServers[name] = resolveServer(def, env, missingVars);
    names.push(name);
  }

  return { document: { mcpServers }, names, missingVars };
}

/**
 * Write a resolved document to a private temp file and return its path plus a
 * cleanup function.
 *
 * The file lands in the OS temp dir, never the repo: it holds real secrets after
 * interpolation, and a stray `.mcp.json` inside a worktree could be committed by
 * the very agent we handed it to. Mode 0600, and removed in the run's `finally`.
 */
export function materializeMcpConfig(document: object): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "crew-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600 });
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover file in the temp dir is not worth failing a completed run.
      }
    },
  };
}

/**
 * Tool-name patterns that would let a persona write to the issue tracker.
 *
 * The engine owns every tracker mutation on purpose — dedup, the type/volume
 * caps, and the PRD approval gate all live there. A persona that could file
 * directly would bypass all three, so these are refused at config load with an
 * explanation rather than silently granted.
 */
const TRACKER_WRITE_HINTS = [
  "create_issue",
  "save_issue",
  "update_issue",
  "create_ticket",
  "delete_issue",
];

/**
 * Validate an `mcpServers:` block. Returns warnings (non-fatal, printed by
 * `crew doctor`) and throws `McpError` on anything structurally wrong.
 */
export function validateMcpServers(
  servers: Record<string, McpServerConfig>,
): string[] {
  const warnings: string[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (!def.command && !def.url) {
      throw new McpError(`mcpServers.${name}: needs either \`command\` (stdio) or \`url\` (http/sse)`);
    }
    if (def.command && def.url) {
      throw new McpError(`mcpServers.${name}: set \`command\` or \`url\`, not both`);
    }
    // A literal-looking secret in a committed file is the exact failure mode
    // this feature exists to avoid, so it is worth shouting about.
    for (const [k, v] of Object.entries(def.env ?? {})) {
      if (!placeholderRe().test(v) && /^(?:[A-Za-z0-9_-]{24,}|sk-|lin_api_|ghp_)/.test(v)) {
        warnings.push(
          `mcpServers.${name}.env.${k} looks like a literal secret. Use \${${k}} and put the ` +
            `value in .env or ~/.crew/env — config.yaml is committed.`,
        );
      }
    }
    for (const t of def.allowedTools ?? []) {
      if (TRACKER_WRITE_HINTS.some((h) => t.includes(h))) {
        warnings.push(
          `mcpServers.${name}: "${t}" can write to the tracker. Personas return proposals for ` +
            `the engine to file — direct writes bypass dedup, allowedTypes/maxProposals, and ` +
            `the PRD approval gate. Note allowedTools is advisory, NOT enforced (headless runs ` +
            `skip permissions): issue this server a read-only token instead.`,
        );
      }
    }
  }
  return warnings;
}

/**
 * The tools a persona's granted servers pin, namespaced the way MCP exposes
 * them (`mcp__<server>__<tool>`), for display in `crew agents` and to inject
 * into the prompt as an instruction.
 *
 * This is NOT an enforcement boundary. crew runs agents with
 * `--dangerously-skip-permissions` (it has to: a headless run has nobody to
 * answer a permission prompt), and that bypasses the permission system
 * wholesale — `--allowedTools` alongside it is inert. Verified against Claude
 * Code directly, not assumed. The real boundaries are which servers a persona
 * is granted at all, and the scope of the token you issue it.
 *
 * A server that pins tools contributes only its pinned ones; a server that
 * doesn't is represented by a `mcp__<server>__*` wildcard, so a mixed grant
 * doesn't silently read as "the unpinned server was excluded".
 *
 * Returns `null` when nothing is granted, or when no granted server pins
 * anything (there is no restriction worth stating).
 */
export function pinnedToolsFor(
  grants: string[] | undefined,
  servers: Record<string, McpServerConfig>,
): string[] | null {
  if (!grants?.length) return null;
  const anyPinned = grants.some((n) => servers[n]?.allowedTools?.length);
  if (!anyPinned) return null;

  const out: string[] = [];
  for (const name of grants) {
    const def = servers[name];
    if (!def) continue;
    if (!def.allowedTools?.length) {
      // Granted but unrestricted — every tool it exposes stays available.
      out.push(`mcp__${name}__*`);
      continue;
    }
    for (const tool of def.allowedTools) {
      out.push(tool.startsWith("mcp__") ? tool : `mcp__${name}__${tool}`);
    }
  }
  return out.length ? out : null;
}
