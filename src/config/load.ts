import { readFileSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./schema.js";
import { McpError, validateMcpServers } from "./mcp.js";
import { findConfigRoot, inspectRepo, isGitRepo } from "../git/discover.js";
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
 * The repo crew should operate on, when the caller wants to override discovery.
 * `CREW_REPO` lets you drive a sibling repo without cd-ing into it, which is
 * the point of keeping several related repos in one directory.
 */
export function crewRepoOverride(): string | undefined {
  const v = process.env.CREW_REPO?.trim();
  return v && v.length > 0 ? resolve(v) : undefined;
}

/**
 * Load and validate <crewDir>/config.yaml from a target repo, resolving absolute
 * paths.
 *
 * `startDir` may be the repo root or any directory inside it: the crew dir is
 * found by walking up, the way git and npm locate their own roots. Fields the
 * config leaves at their defaults are filled in from git — the repo path, the
 * base branch, and the code host are all facts about the checkout, so reading
 * them beats asking for them.
 */
export function loadConfig(startDir = crewRepoOverride() ?? process.cwd()): CrewConfig {
  const dirName = crewDirName();
  const configRoot = findConfigRoot(startDir, dirName);
  if (!configRoot) {
    throw new ConfigError(
      `No ${dirName}/config.yaml found in ${startDir} or any parent directory. ` +
        `Run \`crew setup\` (or \`crew init\`) first.`,
    );
  }
  const configDir = join(configRoot, dirName);
  const configPath = join(configDir, "config.yaml");

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
  // An explicit non-default path always wins; `"."` is the schema default and
  // means "wherever the config dir lives", so git decides the real root there.
  const explicitPath = raw.repo.path !== ".";
  const declaredPath = isAbsolute(raw.repo.path)
    ? raw.repo.path
    : resolve(configRoot, raw.repo.path);

  const facts = inspectRepo(declaredPath);
  const repoPath = !explicitPath && facts.root ? facts.root : declaredPath;

  // Fail here rather than several minutes into a cycle, where the same mistake
  // surfaces as an opaque `git fetch` error from inside a worktree operation.
  if (!existsSync(repoPath)) {
    throw new ConfigError(
      `repo.path in ${configPath} points at ${repoPath}, which does not exist.`,
    );
  }
  if (!isGitRepo(repoPath)) {
    throw new ConfigError(
      `repo.path in ${configPath} points at ${repoPath}, which is not a git ` +
        `repository. crew needs one to create worktrees and open pull requests.`,
    );
  }
  // A config dir belonging to one repo but pointing at another is almost always
  // a copy-paste slip, and it silently files work against the wrong codebase.
  if (explicitPath && facts.root && facts.root !== repoPath) {
    throw new ConfigError(
      `repo.path in ${configPath} points at ${repoPath}, which is inside the ` +
        `git repository at ${facts.root} rather than being its root. ` +
        `Set repo.path to the repository root.`,
    );
  }

  const inferred = explicitPath ? inspectRepo(repoPath) : facts;
  // Each of these is only inferred when the config left the schema default in
  // place, so anything written by hand always wins.
  const baseBranch =
    raw.repo.baseBranch === "main" && inferred.baseBranch
      ? inferred.baseBranch
      : raw.repo.baseBranch;
  const forge =
    raw.repo.forge === "github" && inferred.forge ? inferred.forge : raw.repo.forge;
  const bitbucketRepo =
    forge === "bitbucket"
      ? (raw.repo.bitbucketRepo ?? inferred.bitbucketRepo)
      : raw.repo.bitbucketRepo;

  const constitutionPath = join(configDir, "constitution.md");
  if (!existsSync(constitutionPath)) {
    throw new ConfigError(
      `Missing ${constitutionPath}. The material-impact constitution is required.`,
    );
  }

  // `linear:` is the pre-Jira spelling of `tracker:`. Accept it verbatim so old
  // configs keep working, but pin the provider to linear — a config written
  // under that key predates the choice and can only have meant Linear.
  const tracker = raw.tracker ?? (raw.linear ? { ...raw.linear, provider: "linear" as const } : null);
  if (!tracker) {
    throw new ConfigError(
      `Invalid config in ${configPath}:\n` +
        `  - tracker: Required (a \`tracker:\` block, or the older \`linear:\` block)`,
    );
  }
  if (raw.tracker && raw.linear) {
    throw new ConfigError(
      `Invalid config in ${configPath}:\n` +
        `  - tracker/linear: define only one — \`linear:\` is the old name for \`tracker:\`.`,
    );
  }

  // Structural problems in the tool block fail here rather than mid-run, where
  // the same mistake surfaces as an agent silently missing the tools it was
  // written to rely on.
  try {
    validateMcpServers(raw.mcpServers);
  } catch (e) {
    if (e instanceof McpError) {
      throw new ConfigError(`Invalid config in ${configPath}:\n  - ${e.message}`);
    }
    throw e;
  }

  // Grants naming an undefined server are caught in `loadAgents`, which sees
  // frontmatter and this block merged — checking only `personas:` here would
  // miss the frontmatter half and let a typo fail open at run time.

  // `linear` is intentionally dropped from the resolved config: the engine reads
  // `cfg.tracker` only, so leaving both would let them drift apart.
  const { linear: _legacy, ...rest } = raw;

  // One slot per worker unless pinned: fewer slots than workers would serialize
  // the team on slot availability rather than on anything real.
  const worktrees = {
    ...raw.worktrees,
    max: raw.worktrees.max ?? raw.budget.implementerWorkers,
  };

  return {
    ...rest,
    tracker,
    worktrees,
    repo: { ...raw.repo, path: repoPath, baseBranch, forge, bitbucketRepo },
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
