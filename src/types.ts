/**
 * Shared contract for the crew engine.
 *
 * Design principle: agents are STATELESS workers, the engine owns ALL state.
 * - Proposer personas return `Proposal[]` (they never write to Linear).
 * - The Implementer persona returns a commit outcome (it never touches Linear).
 * - The engine (via LinearPort + GitPort) performs every Linear transition and
 *   git/PR operation deterministically.
 *
 * Every module implements one of the *Port interfaces below. This is the only
 * file modules should need to agree on.
 */

// ----------------------------- domain -------------------------------------

export type ItemType = "prd" | "bug" | "task" | "chore-dx" | "spike";

export type PersonaName =
  | "implementer"
  | "qa"
  | "design"
  | "architect"
  | "triager";

export type Severity = "low" | "medium" | "high" | "critical";

export type Complexity = "low" | "medium" | "high";

/** A normalized Linear issue as the engine sees it. */
export interface WorkItem {
  id: string;
  /** Human key, e.g. "BRI-123". */
  identifier: string;
  title: string;
  description: string;
  /** Derived from the type:* label; null if none. */
  type: ItemType | null;
  /** Current workflow state name, e.g. "Todo". */
  stateName: string;
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 normal, 4 low. */
  priority: number;
  /** Parent issue id (for PRD decomposition), else null. */
  parentId: string | null;
  /**
   * null  = no parent PRD (ungated),
   * true  = parent PRD is in an approved state,
   * false = parent PRD exists but is NOT approved (must be blocked).
   */
  parentApproved: boolean | null;
  url: string;
  assigneeId: string | null;
  labels: string[];
  /** From a `complexity:*` label; drives which model implements it. */
  complexity?: Complexity | null;
}

/** A unit of work an agent proposes; the engine dedups then creates it. */
export interface Proposal {
  type: ItemType;
  title: string;
  /** Markdown body (for PRDs, the full PRD). */
  body: string;
  severity?: Severity;
  /** Rough implementation complexity; selects the model that implements it. */
  complexity?: Complexity;
  /** Where the agent saw the problem (file paths, screenshots, test names). */
  evidence?: string;
  /**
   * True if this crosses the "material impact" constitution and therefore must
   * be filed as a PRD in Needs Approval rather than executed. The engine
   * re-checks/forces this; the agent's own read is advisory.
   */
  isMaterial: boolean;
}

/** What a single headless persona run returns to the engine. */
export interface PersonaResult {
  /** Proposer output. */
  proposals?: Proposal[];
  /** Implementer output: did it produce a commit on the branch? */
  committed?: boolean;
  /** Short human summary of what happened. */
  summary?: string;
  /** Self-review DX friction items (Implementer only). */
  friction?: Proposal[];
  /** True if the run hit the Claude subscription usage limit. */
  usageLimited?: boolean;
  /** Parsed reset time if the usage message included one (ISO 8601), else null. */
  resetAt?: string | null;
  /** Raw stdout, for logging/debugging. */
  raw?: string;
}

// ----------------------------- config -------------------------------------

export interface CrewConfig {
  project: string;
  repo: { path: string; baseBranch: string };
  linear: {
    team: string;
    /** Optional Linear project (name or id) to scope this repo's issues to. */
    project?: string;
    labels: Record<"prd" | "bug" | "task" | "chore", string>;
    statuses: {
      backlog: string;
      ready: string;
      inProgress: string;
      review: string;
      needsApproval: string;
      done: string;
    };
    /** State names considered "approved" for a parent PRD. */
    approvedStates: string[];
    /** Non-material proposals go straight to the ready state (default true). */
    autoPromote: boolean;
  };
  budget: {
    target: "max-monthly" | "fixed";
    implementerWorkers: number;
    /** Fixed fallback back-off (minutes) when a reset time can't be parsed. */
    backoffMinutes: number;
    /** Seconds between engine ticks. */
    pollSeconds: number;
  };
  gates: {
    wipCap: number;
    /** Optional env-prep command run before verify, in the same shell. */
    setup?: string;
    /** app name -> verify command run from repo root. */
    verify: Record<string, string>;
    /** globs the Implementer must never modify. */
    noTouch: string[];
  };
  personas: Partial<Record<PersonaName, { cadence: string; model?: string }>>;
  /** Model selection. byComplexity overrides the default for that complexity. */
  models: {
    default?: string;
    byComplexity: { low?: string; medium?: string; high?: string };
  };
  triager: { cadence: string; dedupThreshold: number; backlogCap: number };

  // Resolved at load time (not in the yaml):
  /** Absolute path to the target repo's crew config directory (default .crew/). */
  configDir: string;
  /** Absolute path to constitution.md. */
  constitutionPath: string;
}

// ----------------------------- ports --------------------------------------

/** Resolved Linear identifiers so we don't re-query names every call. */
export interface LinearMeta {
  teamId: string;
  myUserId: string;
  /** label name -> id */
  labelIds: Record<string, string>;
  /** state name -> id */
  stateIds: Record<string, string>;
  /** Resolved project id, if the repo is scoped to a Linear project. */
  projectId?: string;
}

export interface LinearPort {
  resolveMeta(): Promise<LinearMeta>;

  /**
   * The core selection query for the Implementer. Returns the single highest
   * priority executable item, or null. MUST exclude: items not in `ready`
   * state, items whose parent PRD is not approved (parentApproved === false),
   * and anything already in progress.
   */
  selectNextExecutable(): Promise<WorkItem | null>;

  /** How many items are currently in the inProgress state (for the WIP cap). */
  countInProgress(): Promise<number>;

  /** Count of items in the backlog state (for the Triager's intake cap). */
  countBacklog(): Promise<number>;

  /** Move an issue to a named workflow state. */
  transition(issueId: string, toStateName: string): Promise<void>;

  /** Assign (userId) or unassign (null). */
  assign(issueId: string, userId: string | null): Promise<void>;

  /** Create an issue from a proposal; returns the created WorkItem. */
  createIssue(
    proposal: Proposal,
    opts: { author: PersonaName; parentId?: string; needsApproval?: boolean },
  ): Promise<WorkItem>;

  /** Create child sub-issues under an approved PRD (decomposition). */
  createSubIssues(parentId: string, proposals: Proposal[]): Promise<WorkItem[]>;

  /** Open issues whose title is similar (for dedup before create). */
  findSimilarOpen(title: string): Promise<WorkItem[]>;

  addComment(issueId: string, body: string): Promise<void>;

  /** Mark as duplicate of another, with a link comment. */
  markDuplicate(issueId: string, ofIdentifier: string): Promise<void>;
}

export interface OpenPrOptions {
  repoPath: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  assignee: string;
  label?: string;
}

export interface GitPort {
  /** Fetch + verify the base branch is reachable. */
  syncBase(): Promise<void>;
  /** Create a worktree on `branch` off origin/base; returns its absolute path. */
  createWorktree(branch: string): Promise<string>;
  /** Any commits on the worktree ahead of origin/base? */
  hasCommits(worktreePath: string): Promise<boolean>;
  /** Which app dirs (keys of gates.verify) changed on the branch. */
  changedApps(worktreePath: string, appNames: string[]): Promise<string[]>;
  /** Files matching any noTouch glob that were modified (violations). */
  noTouchViolations(worktreePath: string, globs: string[]): Promise<string[]>;
  push(worktreePath: string, branch: string): Promise<void>;
  /** Open a PR; returns the PR url. */
  openPr(opts: OpenPrOptions): Promise<string>;
  removeWorktree(worktreePath: string): Promise<void>;
}

export interface RunPersonaOptions {
  cwd: string;
  /** Full prompt text (persona prompt + injected context) piped to claude. */
  prompt: string;
  model?: string;
  /** If true, we expect structured JSON (proposers); else a commit outcome. */
  expectJson: boolean;
  /** Called with a compact line for each streamed agent step (tool use, text). */
  onActivity?: (line: string) => void;
}

export interface PersonaPort {
  /** Spawn one headless `claude` run and return a parsed PersonaResult. */
  run(name: PersonaName, opts: RunPersonaOptions): Promise<PersonaResult>;
}

// ----------------------------- logging ------------------------------------

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
