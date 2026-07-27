import type {
  AgentDef,
  CrewConfig,
  GitPort,
  PersonaName,
  PersonaPort,
  TrackerMeta,
  TrackerPort,
} from "../types.js";
import { createTracker, TrackerAuthError } from "../tracker/factory.js";
import { createForge, ForgeAuthError } from "../git/forge/factory.js";
import { GitAdapter } from "../git/git.js";
import { PersonaRunner } from "../personas/runner.js";
import { loadConstitution } from "../config/load.js";
import { loadEnvFiles } from "../util/env.js";
import { loadAgents } from "../agent/agents.js";

/** Everything the engine cycles need, constructed once per process. */
export interface Ports {
  /** The configured issue tracker (Linear or Jira). */
  tracker: TrackerPort;
  git: GitPort;
  persona: PersonaPort;
  meta: TrackerMeta;
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

/**
 * Build and wire all ports from config + environment. Which tracker gets built,
 * and which credentials it needs, follows `tracker.provider`.
 */
export async function buildPorts(cfg: CrewConfig): Promise<Ports> {
  // Pull secrets from <crewDir>/.env or ~/.crew/env if not already in the shell.
  loadEnvFiles(cfg.configDir);

  let tracker;
  try {
    tracker = createTracker(cfg);
  } catch (e) {
    // Re-raise as PortsError so callers keep treating credentials problems as
    // a startup failure rather than an unexpected crash.
    if (e instanceof TrackerAuthError) throw new PortsError(e.message);
    throw e;
  }

  const meta = await tracker.resolveMeta();

  let forge;
  try {
    forge = await createForge(cfg);
  } catch (e) {
    if (e instanceof ForgeAuthError) throw new PortsError(e.message);
    throw e;
  }
  const git = new GitAdapter(cfg.repo.path, cfg.repo.baseBranch, forge);

  const loaded = loadAgents(cfg);
  // The runner needs the resolved agents to look up each persona's MCP grants.
  const persona = new PersonaRunner(cfg, loaded);

  const agents: Record<PersonaName, AgentDef> = {};
  for (const a of loaded) agents[a.name] = a;

  return { tracker, git, persona, meta, agents, constitution: loadConstitution(cfg) };
}
