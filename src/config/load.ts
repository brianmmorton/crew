import { readFileSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./schema.js";
import type { CrewConfig } from "../types.js";

export class ConfigError extends Error {}

/**
 * The repo-relative directory crew stores its config in. Defaults to `.crew`
 * (branded, to avoid colliding with the `.agents/` protocol or other tools).
 * Override with the CREW_DIR env var if that name is taken in your repo.
 */
export function crewDirName(): string {
  const v = process.env.CREW_DIR?.trim();
  return v && v.length > 0 ? v : ".crew";
}

/**
 * Load and validate <crewDir>/config.yaml from a target repo, resolving absolute
 * paths. `startDir` is the repo root (or any dir containing the crew dir).
 */
export function loadConfig(startDir = process.cwd()): CrewConfig {
  const dirName = crewDirName();
  const configDir = resolve(startDir, dirName);
  const configPath = join(configDir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `No ${dirName}/config.yaml found under ${startDir}. Run \`crew setup\` (or \`crew init\`) first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new ConfigError(`Could not parse ${configPath}: ${(e as Error).message}`);
  }

  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new ConfigError(
      `Invalid config in ${configPath}:\n` +
        result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
  }

  const raw = result.data;
  const repoPath = isAbsolute(raw.repo.path)
    ? raw.repo.path
    : resolve(startDir, raw.repo.path);

  const constitutionPath = join(configDir, "constitution.md");
  if (!existsSync(constitutionPath)) {
    throw new ConfigError(
      `Missing ${constitutionPath}. The material-impact constitution is required.`,
    );
  }

  return {
    ...raw,
    repo: { ...raw.repo, path: repoPath },
    configDir,
    constitutionPath,
  };
}

/** Read a persona prompt file from <crewDir>/personas/<name>.md. */
export function loadPersonaPrompt(cfg: CrewConfig, name: string): string {
  const p = join(cfg.configDir, "personas", `${name}.md`);
  if (!existsSync(p)) {
    throw new ConfigError(`Missing persona prompt ${p}`);
  }
  return readFileSync(p, "utf8");
}

export function loadConstitution(cfg: CrewConfig): string {
  return readFileSync(cfg.constitutionPath, "utf8");
}
