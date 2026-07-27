import type { CrewConfig, PersonaName, PersonaPort, PersonaResult, RunPersonaOptions } from "../types.js";
import { runClaude } from "../agent/claude.js";
import { runGeneric } from "../agent/generic.js";

export { killActiveRuns } from "../agent/registry.js";

/**
 * Provider-agnostic persona runner. Dispatches each run to the configured agent
 * CLI: the built-in "claude" adapter (streaming + subscription auth), or the
 * generic command adapter for any other CLI (Codex, Cursor, Grok, a script…).
 */
export class PersonaRunner implements PersonaPort {
  constructor(private readonly cfg: CrewConfig) {}

  run(_name: PersonaName, opts: RunPersonaOptions): Promise<PersonaResult> {
    const provider = this.cfg.agent?.provider ?? "claude";
    if (provider === "claude") return runClaude(opts);
    return runGeneric(this.cfg.agent, opts);
  }
}
