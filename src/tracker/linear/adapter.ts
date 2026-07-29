import { LinearClient } from "@linear/sdk";
import type { Issue, Team } from "@linear/sdk";
import type {
  CrewConfig,
  EmptySelectionReason,
  PersonaName,
  Proposal,
  TrackerMeta,
  TrackerPort,
  WorkItem,
} from "../../types.js";
import { isDuplicate } from "../dedup.js";
import {
  AGENT_AUTHORED_LABEL,
  COMPLEXITY_PREFIX,
  DEDUP_THRESHOLD,
  complexityFromLabels,
  labelNameToType,
  severityToPriority,
  typeToLabelName,
} from "../shared.js";
import { explainEmpty, isExecutable, labelGateActive, rankCandidates } from "../selection.js";

/** Modest page size for the queries we run. */
const PAGE = 250;

export class LinearAdapter implements TrackerPort {
  private readonly client: LinearClient;
  private readonly cfg: CrewConfig;

  private meta: TrackerMeta | null = null;
  private team: Team | null = null;
  /** First canceled-type workflow state id, if any (for cancel/duplicate fallback). */
  private canceledStateId: string | null = null;

  constructor(apiKey: string, cfg: CrewConfig) {
    this.client = new LinearClient({ apiKey });
    this.cfg = cfg;
  }

  // --------------------------- meta / guards ------------------------------

  async resolveMeta(): Promise<TrackerMeta> {
    const teamName = this.cfg.tracker.team;
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
    let boardUrl: string | undefined;
    if (this.cfg.tracker.project) {
      const want = this.cfg.tracker.project;
      const projConn = await team.projects({ first: PAGE });
      const proj = projConn.nodes.find((p) => p.name === want || p.id === want);
      if (!proj) {
        throw new Error(`Linear project not found in team "${teamName}": "${want}"`);
      }
      projectId = proj.id;
      // A scoped repo's board IS the project page; Linear hands us its url.
      boardUrl = proj.url;
    }
    if (!boardUrl) {
      // Team issue list: linear.app/<workspace-slug>/team/<KEY>/all. The slug
      // lives on the organization — one extra boot-time read, and cosmetic, so
      // a failure here degrades to "no link" rather than a failed boot.
      try {
        const org = await this.client.organization;
        boardUrl = `https://linear.app/${org.urlKey}/team/${team.key}/all`;
      } catch {
        boardUrl = undefined;
      }
    }

    this.meta = {
      teamId: team.id,
      myUserId: viewer.id,
      labelIds,
      stateIds,
      projectId,
      boardUrl,
    };

    // Ensure the configured type labels exist (create on the fly if missing).
    const typeLabels = this.cfg.tracker.labels;
    for (const name of [typeLabels.prd, typeLabels.bug, typeLabels.task, typeLabels.chore]) {
      await this.ensureLabelId(name);
    }

    return this.meta;
  }

  private ensureMeta(): TrackerMeta {
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

  /**
   * Issue-filter fragment for the executable label gate, so an excluded item
   * never occupies a slot in the `first: PAGE` window. `isExecutable` applies
   * the same rules again client-side — this is an optimization, not the
   * enforcement point.
   *
   * `every: { nin }` is vacuously true for an issue with no labels, so an
   * exclude-only config still picks up unlabeled work. (Jira's equivalent needs
   * an explicit `labels is EMPTY` for this — see JiraAdapter.labelClause.)
   */
  private labelFilter(): Record<string, unknown> {
    const gate = this.cfg.tracker.executable;
    const and: Record<string, unknown>[] = [];
    if (gate?.requireLabels?.length) {
      and.push({ labels: { some: { name: { in: gate.requireLabels } } } });
    }
    if (gate?.excludeLabels?.length) {
      and.push({ labels: { every: { name: { nin: gate.excludeLabels } } } });
    }
    return and.length ? { and } : {};
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
      parentApproved = this.cfg.tracker.approvedStates.includes(name);
    }

    const labelNames = labelConn.nodes.map((l) => l.name);
    const type =
      labelNames.map((n) => labelNameToType(this.cfg.tracker, n)).find((t) => t !== null) ??
      null;

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
      complexity: complexityFromLabels(labelNames),
    };
  }

  // ---------------------------- selection ---------------------------------

  async selectNextExecutable(): Promise<WorkItem | null> {
    this.ensureMeta();
    const team = this.ensureTeam();

    const conn = await team.issues({
      filter: {
        state: { name: { eq: this.cfg.tracker.statuses.ready } },
        ...this.projectFilter(),
        ...this.labelFilter(),
      },
      first: PAGE,
    });

    const items = await Promise.all(conn.nodes.map((i) => this.toWorkItem(i)));
    const executable = items.filter((i) => isExecutable(i, this.cfg));
    const ranked = rankCandidates(executable);
    return ranked[0] ?? null;
  }

  /**
   * Re-run the ready-state query *without* the label clause, so the caller can
   * tell an empty queue from one the gate emptied. Skipped entirely when no
   * gate is configured — there'd be nothing to attribute, and this costs a
   * second query.
   */
  async explainEmptySelection(): Promise<EmptySelectionReason | null> {
    if (!labelGateActive(this.cfg)) return null;
    this.ensureMeta();
    const team = this.ensureTeam();

    const conn = await team.issues({
      filter: {
        state: { name: { eq: this.cfg.tracker.statuses.ready } },
        ...this.projectFilter(),
      },
      first: PAGE,
    });
    const items = await Promise.all(conn.nodes.map((i) => this.toWorkItem(i)));
    return explainEmpty(items, this.cfg);
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
    return this.countInState(this.cfg.tracker.statuses.inProgress);
  }

  async countBacklog(): Promise<number> {
    return this.countInState(this.cfg.tracker.statuses.backlog);
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

  async setLabels(
    issueId: string,
    change: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    this.ensureMeta();
    const add = change.add?.filter((l) => l.trim()) ?? [];
    const remove = new Set(change.remove?.filter((l) => l.trim()) ?? []);
    if (!add.length && !remove.size) return;

    // Linear's updateIssue replaces the label set outright, so the current
    // labels have to be read first — anything else would drop the type and
    // agent labels the item was created with.
    const issue = await this.client.issue(issueId);
    const current = await issue.labels();

    const keep: string[] = [];
    for (const l of current.nodes) {
      if (!remove.has(l.name) && !keep.includes(l.id)) keep.push(l.id);
    }
    for (const name of new Set(add)) {
      const id = await this.ensureLabelId(name);
      // Distinct names can resolve to one id (Linear names are
      // case-insensitive), and a repeated id fails the whole mutation.
      if (!keep.includes(id)) keep.push(id);
    }

    await this.client.updateIssue(issueId, { labelIds: keep });
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
      typeToLabelName(this.cfg.tracker, proposal.type),
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
      ? this.cfg.tracker.statuses.needsApproval
      : this.cfg.tracker.statuses.backlog;
    const stateId = this.stateIdOrThrow(stateName);

    const payload = await this.client.createIssue({
      teamId: meta.teamId,
      title: proposal.title,
      description: proposal.body,
      labelIds,
      priority: severityToPriority(proposal.severity),
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
    const stateId = this.stateIdOrThrow(this.cfg.tracker.statuses.ready);

    const created: WorkItem[] = [];
    for (const proposal of proposals) {
      const typeLabelId = await this.ensureLabelId(typeToLabelName(this.cfg.tracker, proposal.type));
      const payload = await this.client.createIssue({
        teamId: meta.teamId,
        title: proposal.title,
        description: proposal.body,
        labelIds: [typeLabelId],
        priority: severityToPriority(proposal.severity),
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
