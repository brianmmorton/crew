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

/**
 * A persona's name. Open by design: the four built-ins are conventions, not a
 * closed set — any `<crewDir>/personas/<name>.md` defines an agent. See
 * `AgentDef` for what an agent is and `src/agent/agents.ts` for discovery.
 */
export type PersonaName = string;

/** The built-in personas crew scaffolds and knows how to describe. */
export const BUILTIN_PERSONAS = [
  "implementer",
  "qa",
  "design",
  "architect",
  "triager",
] as const;

/**
 * What an agent *does*, which decides how the engine drives it:
 * - `proposer` — read-only; analyzes the repo and returns proposals to file.
 * - `executor` — claims a work item, implements it in a worktree, opens a PR.
 * - `reviewer` — runs after a PR opens; returns comments/transitions to apply.
 */
export type AgentKind = "proposer" | "executor" | "reviewer";

/**
 * The per-agent settings a user can write, in either `config.yaml`'s
 * `personas:` block or a persona file's frontmatter. Every field is optional so
 * a bare `personas/<name>.md` with no config at all is a valid agent.
 */
export interface PersonaConfig {
  kind?: AgentKind;
  cadence?: string;
  model?: string;
  description?: string;
  allowedTypes?: ItemType[];
  maxProposals?: number;
  label?: string;
  claims?: string[];
  canTransitionTo?: string[];
}

/**
 * A fully-resolved agent: its prompt plus the options that govern it. Built by
 * `loadAgents()` from `personas/<name>.md` (optional frontmatter) merged with
 * the `personas:` block in config.yaml — config.yaml wins on conflict.
 */
export interface AgentDef {
  name: PersonaName;
  kind: AgentKind;
  /** The persona prompt (frontmatter stripped). */
  prompt: string;
  /** Cron cadence, or "continuous" for executors driven by the executor loop. */
  cadence: string;
  /** Model override for this agent; falls back to the global default. */
  model?: string;
  /** One-line description for `crew agents`. */
  description?: string;
  /** True if this is one of BUILTIN_PERSONAS. */
  builtin: boolean;

  // --- proposer options ---
  /** Item types this agent may file. Empty/undefined = all types allowed. */
  allowedTypes?: ItemType[];
  /** Max proposals accepted from one run (extras are dropped, with a warning). */
  maxProposals?: number;
  /** Extra Linear label applied to everything this agent files. */
  label?: string;

  // --- executor options ---
  /**
   * Labels this executor claims. An item routes to the first executor whose
   * claims intersect the item's labels; unclaimed items fall to `implementer`.
   */
  claims?: string[];

  // --- reviewer options ---
  /**
   * Workflow states this reviewer may move an issue to. The engine rejects any
   * transition not on this list. Empty/undefined = comment-only.
   */
  canTransitionTo?: string[];
}

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

/**
 * A reviewer's verdict on an opened PR. The reviewer performs NO actions — it
 * returns this and the engine applies each part, enforcing `canTransitionTo`.
 */
export interface ReviewOutcome {
  /** Overall read: "approve" | "comment" | "changes-requested". Advisory. */
  verdict?: "approve" | "comment" | "changes-requested";
  /** Markdown posted as a comment on the pull request. */
  prComment?: string;
  /** Markdown posted as a comment on the Linear issue. */
  issueComment?: string;
  /** Workflow state to move the issue to; ignored unless on canTransitionTo. */
  transitionTo?: string;
}

/** What a single headless persona run returns to the engine. */
export interface PersonaResult {
  /** Proposer output. */
  proposals?: Proposal[];
  /** Reviewer output. */
  review?: ReviewOutcome;
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
  /**
   * Per-agent settings, keyed by persona name. Merged over any frontmatter in
   * `personas/<name>.md`; see `AgentDef` for what each field means.
   */
  personas: Record<PersonaName, PersonaConfig>;
  /** Which coding-agent CLI to drive. "claude" is built-in; else generic command. */
  agent: {
    provider: string;
    command?: string;
    args: string[];
    promptVia: "stdin" | "arg";
    modelFlag?: string;
  };
  /** Model selection. byComplexity overrides the default for that complexity. */
  models: {
    default?: string;
    byComplexity: { low?: string; medium?: string; high?: string };
  };
  triager: {
    cadence: string;
    dedupThreshold: number;
    backlogCap: number;
    dedupLookbackDays: number;
  };
  /** Idle-triggered proposers: run them early when the executor runs dry. */
  idle: {
    enabled: boolean;
    afterMinutes: number;
    minIntervalMinutes: number;
    maxBacklog: number;
    maxEmptyRuns: number;
    agents: string[];
  };

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
    opts: {
      author: PersonaName;
      parentId?: string;
      needsApproval?: boolean;
      /** Extra label to apply (an agent's `label` option); created if missing. */
      label?: string;
    },
  ): Promise<WorkItem>;

  /** Create child sub-issues under an approved PRD (decomposition). */
  createSubIssues(parentId: string, proposals: Proposal[]): Promise<WorkItem[]>;

  /**
   * Issues whose title is similar (for dedup before create). Covers open work
   * plus recently completed and canceled work, so an agent can't re-file
   * something that just shipped or that a human explicitly rejected.
   */
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
  /**
   * An existing usable worktree for `branch`, or null. Used to resume a run
   * that committed work but failed afterwards (push/PR), so the commit isn't
   * thrown away and redone.
   */
  findWorktree(branch: string): Promise<string | null>;
  /** Any commits on the worktree ahead of origin/base? */
  hasCommits(worktreePath: string): Promise<boolean>;
  /** Which app dirs (keys of gates.verify) changed on the branch. */
  changedApps(worktreePath: string, appNames: string[]): Promise<string[]>;
  /** Files matching any noTouch glob that were modified (violations). */
  noTouchViolations(worktreePath: string, globs: string[]): Promise<string[]>;
  push(worktreePath: string, branch: string): Promise<void>;
  /** Open a PR; returns the PR url. */
  openPr(opts: OpenPrOptions): Promise<string>;
  /** Post a comment on an existing PR (used by reviewer agents). */
  commentOnPr(prUrl: string, body: string): Promise<void>;
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
