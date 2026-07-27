import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
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
import { loadPersonaPrompt, loadConstitution } from "../config/load.js";
import { loadEnvFiles } from "../util/env.js";

/** Everything the engine cycles need, constructed once per process. */
export interface Ports {
  linear: LinearPort;
  git: GitPort;
  persona: PersonaPort;
  meta: LinearMeta;
  prompts: Partial<Record<PersonaName, string>>;
  constitution: string;
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

  const prompts: Partial<Record<PersonaName, string>> = {};
  const names: PersonaName[] = ["implementer", "qa", "design", "architect", "triager"];
  for (const n of names) {
    if (existsSync(join(cfg.configDir, "personas", `${n}.md`))) {
      prompts[n] = loadPersonaPrompt(cfg, n);
    }
  }

  return { linear, git, persona, meta, prompts, constitution: loadConstitution(cfg) };
}
