import type {
  AgentDef,
  CrewConfig,
  GitPort,
  LinearMeta,
  LinearPort,
  PersonaName,
  PersonaPort,
} from "../types.js";
import { LinearAdapter } from "../linear/adapter.js";
import { GitAdapter } from "../git/git.js";
import { PersonaRunner } from "../personas/runner.js";
import { loadConstitution } from "../config/load.js";
import { loadEnvFiles } from "../util/env.js";
import { loadAgents } from "../agent/agents.js";

/** Everything the engine cycles need, constructed once per process. */
export interface Ports {
  linear: LinearPort;
  git: GitPort;
  persona: PersonaPort;
  meta: LinearMeta;
  /** Every agent discovered for this project, keyed by name. */
  agents: Record<PersonaName, AgentDef>;
  constitution: string;
}

/** Look an agent up by name, or null if this project doesn't define it. */
export function agent(ports: Ports, name: PersonaName): AgentDef | null {
  return ports.agents[name] ?? null;
}

/** Every agent as a list, in stable name order. */
export function agentList(ports: Ports): AgentDef[] {
  return Object.values(ports.agents).sort((a, b) => a.name.localeCompare(b.name));
}

export class PortsError extends Error {}

/** Build and wire all ports from config + environment (LINEAR_API_KEY). */
export async function buildPorts(cfg: CrewConfig): Promise<Ports> {
  // Pull secrets from <crewDir>/.env or ~/.crew/env if not already in the shell.
  loadEnvFiles(cfg.configDir);

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new PortsError(
      "LINEAR_API_KEY is not set. Put it (and CLAUDE_CODE_OAUTH_TOKEN) in " +
        `${cfg.configDir}/.env or ~/.crew/env, or export it in your shell.`,
    );
  }

  const linear = new LinearAdapter(apiKey, cfg);
  const meta = await linear.resolveMeta();
  const git = new GitAdapter(cfg.repo.path, cfg.repo.baseBranch);
  const persona = new PersonaRunner(cfg);

  const agents: Record<PersonaName, AgentDef> = {};
  for (const a of loadAgents(cfg)) agents[a.name] = a;

  return { linear, git, persona, meta, agents, constitution: loadConstitution(cfg) };
}
