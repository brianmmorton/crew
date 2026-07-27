/**
 * Agent discovery and resolution.
 *
 * An agent is a markdown prompt at `<crewDir>/personas/<name>.md`. Everything
 * else about it — what kind it is, how often it runs, what it may file — comes
 * from optional YAML frontmatter in that file, merged with the `personas:`
 * block in config.yaml (config.yaml wins, so you can override a shared persona
 * file per project without editing it).
 *
 * The four built-ins (implementer/qa/design/architect) are just personas that
 * ship with sensible defaults; users add their own the same way.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  BUILTIN_PERSONAS,
  type AgentDef,
  type AgentKind,
  type CrewConfig,
  type ItemType,
  type PersonaConfig,
  type PersonaName,
} from "../types.js";

/** Default kind for the built-ins, so existing configs keep working verbatim. */
const BUILTIN_KINDS: Record<string, AgentKind> = {
  implementer: "executor",
  qa: "proposer",
  design: "proposer",
  architect: "proposer",
  triager: "proposer",
};

const VALID_KINDS: AgentKind[] = ["proposer", "executor", "reviewer"];
const VALID_TYPES: ItemType[] = ["prd", "bug", "task", "chore-dx", "spike"];

/** A persona name must be filename- and CLI-safe. */
export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(name);
}

export class AgentError extends Error {}

/** Frontmatter split: leading `---\n...\n---\n` block, then the prompt body. */
export function splitFrontmatter(src: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed frontmatter is treated as prose rather than failing the run;
    // the agent still works, it just gets defaults.
    return { data: {}, body: src };
  }
  return { data, body: src.slice(m[0].length) };
}

/** Narrow an unknown frontmatter/config blob to the fields we understand. */
function toPersonaConfig(raw: Record<string, unknown>, where: string): PersonaConfig {
  const out: PersonaConfig = {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

  if (raw.kind !== undefined) {
    const k = str(raw.kind);
    if (!k || !VALID_KINDS.includes(k as AgentKind)) {
      throw new AgentError(
        `${where}: invalid kind "${String(raw.kind)}" (expected ${VALID_KINDS.join(" | ")})`,
      );
    }
    out.kind = k as AgentKind;
  }
  out.cadence = str(raw.cadence);
  out.model = str(raw.model);
  out.description = str(raw.description);
  out.label = str(raw.label);
  out.claims = strArr(raw.claims);
  out.canTransitionTo = strArr(raw.canTransitionTo);

  if (raw.allowedTypes !== undefined) {
    const types = strArr(raw.allowedTypes) ?? [];
    const bad = types.filter((t) => !VALID_TYPES.includes(t as ItemType));
    if (bad.length) {
      throw new AgentError(
        `${where}: invalid allowedTypes ${bad.join(", ")} (expected ${VALID_TYPES.join(" | ")})`,
      );
    }
    out.allowedTypes = types as ItemType[];
  }
  if (raw.maxProposals !== undefined) {
    const n = Number(raw.maxProposals);
    if (!Number.isInteger(n) || n < 1) {
      throw new AgentError(`${where}: maxProposals must be a positive integer`);
    }
    out.maxProposals = n;
  }
  return out;
}

/** Later sources win, but only where they actually define a value. */
function merge(...layers: PersonaConfig[]): PersonaConfig {
  const out: PersonaConfig = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Absolute path to the personas directory for a config. */
export function personasDir(cfg: CrewConfig): string {
  return join(cfg.configDir, "personas");
}

/** Names of every persona file present on disk, sorted. */
export function discoverPersonaFiles(cfg: CrewConfig): PersonaName[] {
  const dir = personasDir(cfg);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((n) => isValidAgentName(n))
    .sort();
}

/**
 * Resolve every agent for this project: one per persona file on disk. An entry
 * in config.yaml with no matching file is reported, not silently ignored —
 * that's almost always a typo.
 */
export function loadAgents(cfg: CrewConfig): AgentDef[] {
  const dir = personasDir(cfg);
  const names = discoverPersonaFiles(cfg);
  const agents: AgentDef[] = [];

  for (const name of names) {
    const file = join(dir, `${name}.md`);
    const { data, body } = splitFrontmatter(readFileSync(file, "utf8"));
    const fromFile = toPersonaConfig(data, `personas/${name}.md frontmatter`);
    const fromConfig = toPersonaConfig(
      (cfg.personas?.[name] ?? {}) as Record<string, unknown>,
      `config.yaml personas.${name}`,
    );
    const m = merge(fromFile, fromConfig);
    const builtin = (BUILTIN_PERSONAS as readonly string[]).includes(name);
    const kind = m.kind ?? BUILTIN_KINDS[name] ?? "proposer";

    agents.push({
      name,
      kind,
      prompt: body,
      // Executors are driven by the executor loop, not cron.
      cadence: m.cadence ?? (kind === "executor" ? "continuous" : ""),
      model: m.model,
      description: m.description,
      builtin,
      allowedTypes: m.allowedTypes,
      maxProposals: m.maxProposals,
      label: m.label,
      claims: m.claims,
      canTransitionTo: m.canTransitionTo,
    });
  }

  return agents;
}

/** config.yaml entries that have no persona file — surfaced as warnings. */
export function orphanedConfigEntries(cfg: CrewConfig): PersonaName[] {
  const onDisk = new Set(discoverPersonaFiles(cfg));
  return Object.keys(cfg.personas ?? {}).filter((n) => !onDisk.has(n));
}

// --------------------------- selection helpers ------------------------------

/** Agents of a kind that are actually enabled (a proposer needs a cadence). */
export function agentsOfKind(agents: AgentDef[], kind: AgentKind): AgentDef[] {
  return agents.filter((a) => a.kind === kind);
}

/** Proposers/reviewers that are scheduled to run on a cron cadence. */
export function scheduledAgents(agents: AgentDef[]): AgentDef[] {
  return agents.filter(
    (a) => a.kind !== "executor" && !!a.cadence && a.cadence !== "continuous",
  );
}

/**
 * Pick the executor for a work item: the first (by name, for determinism) whose
 * `claims` intersect the item's labels. Falls back to `implementer`, then to
 * any single executor defined, so an unclaimed item is never stranded.
 */
export function executorFor(
  agents: AgentDef[],
  labels: string[],
): AgentDef | null {
  const executors = agentsOfKind(agents, "executor");
  const set = new Set(labels);
  const claimed = executors
    .filter((a) => (a.claims ?? []).some((c) => set.has(c)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (claimed.length) return claimed[0];
  return (
    executors.find((a) => a.name === "implementer") ??
    executors.find((a) => !(a.claims ?? []).length) ??
    null
  );
}

/** Every label claimed by any executor — used to explain routing in `crew agents`. */
export function allClaims(agents: AgentDef[]): string[] {
  return [...new Set(agentsOfKind(agents, "executor").flatMap((a) => a.claims ?? []))];
}
