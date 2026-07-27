import { LinearClient } from "@linear/sdk";
import type { Issue, Team } from "@linear/sdk";
import type {
  Complexity,
  CrewConfig,
  ItemType,
  LinearMeta,
  LinearPort,
  PersonaName,
  Proposal,
  Severity,
  WorkItem,
} from "../types.js";
import { isDuplicate } from "./dedup.js";
import { isExecutable, rankCandidates } from "./selection.js";

/** Labels every agent-authored issue carries. */
const AGENT_AUTHORED_LABEL = "agent-authored";
/** Prefix for the complexity label (e.g. "complexity:high"). */
const COMPLEXITY_PREFIX = "complexity:";
/** Modest page size for the queries we run. */
const PAGE = 250;
const DEDUP_THRESHOLD = 0.85;

export class LinearAdapter implements LinearPort {
  private readonly client: LinearClient;
  private readonly cfg: CrewConfig;

  private meta: LinearMeta | null = null;
  private team: Team | null = null;
  /** First canceled-type workflow state id, if any (for cancel/duplicate fallback). */
  private canceledStateId: string | null = null;

  constructor(apiKey: string, cfg: CrewConfig) {
    this.client = new LinearClient({ apiKey });
    this.cfg = cfg;
  }

  // --------------------------- meta / guards ------------------------------

  async resolveMeta(): Promise<LinearMeta> {
    const teamName = this.cfg.linear.team;
    const teamConn = await this.client.teams({
      filter: { name: { eq: teamName } },
      first: 10,
    });
    const team = teamConn.nodes.find((t) => t.name === teamName) ?? teamConn.nodes[0];
    if (!team) {
      throw new Error(`Linear team not found: "${teamName}"`);
    }
    this.team = team;

    const viewer = await this.client.viewer;

    // Workflow states: name -> id (and capture a canceled state for fallbacks).
    const stateIds: Record<string, string> = {};
    const stateConn = await team.states({ first: PAGE });
    for (const st of stateConn.nodes) {
      stateIds[st.name] = st.id;
      if (this.canceledStateId === null && st.type === "canceled") {
        this.canceledStateId = st.id;
      }
    }

    // Labels: name -> id.
    const labelIds: Record<string, string> = {};
    const labelConn = await team.labels({ first: PAGE });
    for (const lbl of labelConn.nodes) {
      labelIds[lbl.name] = lbl.id;
    }

    // Optional project scoping: resolve the configured project by name or id.
    let projectId: string | undefined;
    if (this.cfg.linear.project) {
      const want = this.cfg.linear.project;
      const projConn = await team.projects({ first: PAGE });
      const proj = projConn.nodes.find((p) => p.name === want || p.id === want);
      if (!proj) {
        throw new Error(`Linear project not found in team "${teamName}": "${want}"`);
      }
      projectId = proj.id;
    }

    this.meta = {
      teamId: team.id,
      myUserId: viewer.id,
      labelIds,
      stateIds,
      projectId,
    };

    // Ensure the configured type labels exist (create on the fly if missing).
    const typeLabels = this.cfg.linear.labels;
    for (const name of [typeLabels.prd, typeLabels.bug, typeLabels.task, typeLabels.chore]) {
      await this.ensureLabelId(name);
    }

    return this.meta;
  }

  private ensureMeta(): LinearMeta {
    if (!this.meta) {
      throw new Error("LinearAdapter.resolveMeta() must be called before other methods");
    }
    return this.meta;
  }

  private ensureTeam(): Team {
    if (!this.team) {
      throw new Error("LinearAdapter.resolveMeta() must be called before other methods");
    }
    return this.team;
  }

  /** Return a label id by name, creating the label in the team if needed. */
  private async ensureLabelId(name: string): Promise<string> {
    const meta = this.ensureMeta();
    const existing = meta.labelIds[name];
    if (existing) return existing;

    const payload = await this.client.createIssueLabel({ name, teamId: meta.teamId });
    const label = await payload.issueLabel;
    if (!label) {
      throw new Error(`Failed to create Linear label: "${name}"`);
    }
    meta.labelIds[name] = label.id;
    return label.id;
  }

  /** Issue-filter fragment scoping to the configured project (empty if none). */
  private projectFilter(): Record<string, unknown> {
    const pid = this.meta?.projectId;
    return pid ? { project: { id: { eq: pid } } } : {};
  }

  private stateIdOrThrow(stateName: string): string {
    const meta = this.ensureMeta();
    const id = meta.stateIds[stateName];
    if (!id) {
      throw new Error(`Unknown Linear workflow state: "${stateName}"`);
    }
    return id;
  }

  // ----------------------------- mapping ----------------------------------

  /** Reverse map: label name -> ItemType, derived from config. */
  private labelNameToType(name: string): ItemType | null {
    const l = this.cfg.linear.labels;
    if (name === l.prd) return "prd";
    if (name === l.bug) return "bug";
    if (name === l.task) return "task";
    if (name === l.chore) return "chore-dx";
    return null;
  }

  /** Config label name for a proposal type ("spike" reuses the task label). */
  private typeToLabelName(type: ItemType): string {
    const l = this.cfg.linear.labels;
    switch (type) {
      case "prd":
        return l.prd;
      case "bug":
        return l.bug;
      case "task":
        return l.task;
      case "chore-dx":
        return l.chore;
      case "spike":
        return l.task;
    }
  }

  private static severityToPriority(severity: Severity | undefined): number {
    switch (severity) {
      case "critical":
        return 1;
      case "high":
        return 2;
      case "medium":
        return 3;
      case "low":
        return 4;
      default:
        return 0;
    }
  }

  /** Resolve the SDK's async relations into a normalized WorkItem. */
  private async toWorkItem(issue: Issue): Promise<WorkItem> {
    const [state, parent, labelConn, assignee] = await Promise.all([
      issue.state,
      issue.parent,
      issue.labels(),
      issue.assignee,
    ]);

    let parentApproved: boolean | null = null;
    if (parent) {
      const parentState = await parent.state;
      const name = parentState?.name ?? "";
      parentApproved = this.cfg.linear.approvedStates.includes(name);
    }

    const labelNames = labelConn.nodes.map((l) => l.name);
    const type =
      labelNames.map((n) => this.labelNameToType(n)).find((t) => t !== null) ?? null;

    let complexity: Complexity | null = null;
    for (const n of labelNames) {
      if (n.startsWith(COMPLEXITY_PREFIX)) {
        const v = n.slice(COMPLEXITY_PREFIX.length);
        if (v === "low" || v === "medium" || v === "high") complexity = v;
      }
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      type,
      stateName: state?.name ?? "",
      priority: issue.priority,
      parentId: parent?.id ?? null,
      parentApproved,
      url: issue.url,
      assigneeId: assignee?.id ?? null,
      labels: labelNames,
      complexity,
    };
  }

  // ---------------------------- selection ---------------------------------

  async selectNextExecutable(): Promise<WorkItem | null> {
    this.ensureMeta();
    const team = this.ensureTeam();

    const conn = await team.issues({
      filter: {
        state: { name: { eq: this.cfg.linear.statuses.ready } },
        ...this.projectFilter(),
      },
      first: PAGE,
    });

    const items = await Promise.all(conn.nodes.map((i) => this.toWorkItem(i)));
    const executable = items.filter((i) => isExecutable(i, this.cfg));
    const ranked = rankCandidates(executable);
    return ranked[0] ?? null;
  }

  private async countInState(stateName: string): Promise<number> {
    this.ensureMeta();
    const team = this.ensureTeam();
    const conn = await team.issues({
      filter: { state: { name: { eq: stateName } }, ...this.projectFilter() },
      first: PAGE,
    });
    return conn.nodes.length;
  }

  async countInProgress(): Promise<number> {
    return this.countInState(this.cfg.linear.statuses.inProgress);
  }

  async countBacklog(): Promise<number> {
    return this.countInState(this.cfg.linear.statuses.backlog);
  }

  // --------------------------- mutations ----------------------------------

  async transition(issueId: string, toStateName: string): Promise<void> {
    const stateId = this.stateIdOrThrow(toStateName);
    await this.client.updateIssue(issueId, { stateId });
  }

  async assign(issueId: string, userId: string | null): Promise<void> {
    this.ensureMeta();
    await this.client.updateIssue(issueId, { assigneeId: userId });
  }

  async createIssue(
    proposal: Proposal,
    opts: {
      author: PersonaName;
      parentId?: string;
      needsApproval?: boolean;
      label?: string;
    },
  ): Promise<WorkItem> {
    const meta = this.ensureMeta();

    // Collect label names first, then dedupe: Linear rejects the whole mutation
    // if labelIds repeats an id. An agent whose `label` option equals a label we
    // already add (e.g. label "agent:product" on the agent named "product", or
    // any "type:*") would otherwise fail every create it attempts.
    const labelNames = [
      this.typeToLabelName(proposal.type),
      AGENT_AUTHORED_LABEL,
      `agent:${opts.author}`,
    ];
    if (proposal.complexity) {
      labelNames.push(`${COMPLEXITY_PREFIX}${proposal.complexity}`);
    }
    // An agent's own `label` option, so its output can be filtered in Linear.
    if (opts.label?.trim()) {
      labelNames.push(opts.label.trim());
    }

    const labelIds: string[] = [];
    for (const name of new Set(labelNames)) {
      const id = await this.ensureLabelId(name);
      // Distinct names can still resolve to one id (Linear label names are
      // case-insensitive), so dedupe on the resolved id too.
      if (!labelIds.includes(id)) labelIds.push(id);
    }

    const stateName = opts.needsApproval
      ? this.cfg.linear.statuses.needsApproval
      : this.cfg.linear.statuses.backlog;
    const stateId = this.stateIdOrThrow(stateName);

    const payload = await this.client.createIssue({
      teamId: meta.teamId,
      title: proposal.title,
      description: proposal.body,
      labelIds,
      priority: LinearAdapter.severityToPriority(proposal.severity),
      stateId,
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    });

    const issue = await payload.issue;
    if (!issue) {
      throw new Error(`Failed to create Linear issue: "${proposal.title}"`);
    }
    return this.toWorkItem(issue);
  }

  async createSubIssues(parentId: string, proposals: Proposal[]): Promise<WorkItem[]> {
    const meta = this.ensureMeta();
    const stateId = this.stateIdOrThrow(this.cfg.linear.statuses.ready);

    const created: WorkItem[] = [];
    for (const proposal of proposals) {
      const typeLabelId = await this.ensureLabelId(this.typeToLabelName(proposal.type));
      const payload = await this.client.createIssue({
        teamId: meta.teamId,
        title: proposal.title,
        description: proposal.body,
        labelIds: [typeLabelId],
        priority: LinearAdapter.severityToPriority(proposal.severity),
        stateId,
        ...(meta.projectId ? { projectId: meta.projectId } : {}),
        parentId,
      });
      const issue = await payload.issue;
      if (!issue) {
        throw new Error(`Failed to create Linear sub-issue: "${proposal.title}"`);
      }
      created.push(await this.toWorkItem(issue));
    }
    return created;
  }

  /**
   * Dedup candidates: everything still open, plus work that is already done or
   * was rejected.
   *
   * Completed work only counts for a window (`dedupLookbackDays`) — a bug fixed
   * a year ago can legitimately regress and should be re-filable. Canceled work
   * has no window: canceling an issue is how a human says "don't do this", and
   * that answer doesn't expire on a timer.
   *
   * Without this, an idle-triggered proposer re-files work that just shipped,
   * autoPromote sends it straight to the ready state, the executor drains it,
   * and the queue empties again — a loop that sustains itself.
   */
  async findSimilarOpen(title: string): Promise<WorkItem[]> {
    this.ensureMeta();
    const team = this.ensureTeam();

    const since = new Date(
      Date.now() - this.cfg.triager.dedupLookbackDays * 24 * 60 * 60 * 1000,
    );

    const conn = await team.issues({
      filter: {
        or: [
          { state: { type: { nin: ["completed", "canceled"] } } },
          // Recently shipped — don't rebuild it.
          {
            state: { type: { eq: "completed" } },
            completedAt: { gte: since },
          },
          // Explicitly rejected — don't re-propose it, ever.
          { state: { type: { eq: "canceled" } } },
        ],
        ...this.projectFilter(),
      },
      first: PAGE,
    });

    const threshold = this.cfg.triager.dedupThreshold ?? DEDUP_THRESHOLD;
    const matches = conn.nodes.filter((i) => isDuplicate(title, i.title, threshold));
    return Promise.all(matches.map((i) => this.toWorkItem(i)));
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId, body });
  }

  async markDuplicate(issueId: string, ofIdentifier: string): Promise<void> {
    const meta = this.ensureMeta();
    await this.addComment(issueId, `Marked as duplicate of ${ofIdentifier}.`);

    const duplicateStateId = meta.stateIds["Duplicate"] ?? this.canceledStateId;
    if (duplicateStateId) {
      await this.client.updateIssue(issueId, { stateId: duplicateStateId });
    }
  }
}
