import type {
  AgentDef,
  CrewConfig,
  PersonaName,
  PersonaPort,
  PersonaResult,
  RunPersonaOptions,
} from "../types.js";
import { runClaude } from "../agent/claude.js";
import { runGeneric } from "../agent/generic.js";
import { McpError, materializeMcpConfig, pinnedToolsFor, resolveMcpForPersona } from "../config/mcp.js";

export { killActiveRuns } from "../agent/registry.js";

/**
 * Provider-agnostic persona runner. Dispatches each run to the configured agent
 * CLI: the built-in "claude" adapter (streaming + subscription auth), or the
 * generic command adapter for any other CLI (Codex, Cursor, Grok, a script…).
 *
 * It also resolves the persona's MCP grants immediately before the spawn and
 * tears the resolved file down after it, so interpolated secrets live only for
 * the duration of one run. See `src/config/mcp.ts`.
 */
export class PersonaRunner implements PersonaPort {
  constructor(
    private readonly cfg: CrewConfig,
    /** Resolved agents, for looking up a persona's MCP grants by name. */
    private readonly agents: AgentDef[] = [],
  ) {}

  async run(name: PersonaName, opts: RunPersonaOptions): Promise<PersonaResult> {
    const grants = this.agents.find((a) => a.name === name)?.mcp;
    let mcp: ReturnType<typeof resolveMcpForPersona> = null;
    try {
      mcp = resolveMcpForPersona(grants, this.cfg.mcpServers ?? {});
    } catch (e) {
      // A bad grant is a config bug, not an agent failure. Report it as a failed
      // run so the cycle records it and moves on, rather than crashing the loop.
      if (e instanceof McpError) {
        return { summary: `[crew] ${name}: ${e.message}`, raw: "" };
      }
      throw e;
    }

    // Missing credentials mean the tools would be present but broken, which is
    // worse than absent: the agent burns a full run discovering it can't
    // authenticate. Skip instead, and say exactly which variables to set.
    if (mcp && mcp.missingVars.length) {
      return {
        summary:
          `[crew] ${name}: skipped — MCP servers (${mcp.names.join(", ")}) need ` +
          `${mcp.missingVars.join(", ")}, which ${mcp.missingVars.length === 1 ? "is" : "are"} ` +
          `unset. Add ${mcp.missingVars.length === 1 ? "it" : "them"} to .env or ~/.crew/env.`,
        raw: "",
      };
    }

    // A tool allowlist can't be enforced on the CLI (headless runs skip the
    // permission system), so pinned tools are stated in the prompt instead.
    // Honest about what it is: an instruction the agent can ignore, which is
    // why the docs point at token scope as the real control.
    const pinned = pinnedToolsFor(grants, this.cfg.mcpServers ?? {});
    const prompt = pinned
      ? `${opts.prompt}\n\n## External tools\nUse only these MCP tools: ${pinned.join(", ")}. ` +
        `A \`*\` suffix means every tool on that server is available.`
      : opts.prompt;

    const materialized = mcp ? materializeMcpConfig(mcp.document) : null;
    const runOpts: RunPersonaOptions = { ...opts, prompt, mcpConfigPath: materialized?.path };

    try {
      if (mcp && opts.onActivity) {
        opts.onActivity(`· mcp: ${mcp.names.join(", ")}`);
      }
      const provider = this.cfg.agent?.provider ?? "claude";
      return provider === "claude"
        ? await runClaude(runOpts)
        : await runGeneric(this.cfg.agent, runOpts);
    } finally {
      // The resolved file holds real secrets — remove it even if the run threw.
      materialized?.cleanup();
    }
  }
}
