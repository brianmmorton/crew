import type {
  CrewConfig,
  ItemType,
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
import { isExecutable, rankCandidates } from "../selection.js";
import {
  JiraClient,
  adfToText,
  textToAdf,
  type FetchLike,
  type JiraAuth,
  type JiraIssue,
} from "./client.js";

/** Modest page size for the queries we run. */
const PAGE = 100;

/**
 * Jira implementation of `TrackerPort`.
 *
 * Three things differ structurally from Linear and shape this file:
 *
 * 1. There is no "set the status" API. A status change must go through a
 *    workflow *transition* that is legal from the issue's current status, so
 *    `transition()` resolves the target by name against the available
 *    transitions rather than writing a state id.
 * 2. Labels are free-form strings with no ids and no create step, so
 *    `labelIds` is an identity map and nothing needs provisioning up front.
 *    Jira labels cannot contain spaces, so they are sanitized on the way out.
 * 3. Priority is a named field that instances can disable, and rich text must
 *    be Atlassian Document Format rather than markdown.
 *
 * `cfg.tracker.team` is the project key; `cfg.tracker.project` is an optional
 * component used to scope one repo within a shared Jira project.
 */
export class JiraAdapter implements TrackerPort {
  private readonly client: JiraClient;
  private readonly cfg: CrewConfig;
  /** Site host, kept to build `WorkItem.url` (the API never returns one). */
  private readonly host: string;

  private meta: TrackerMeta | null = null;
  /** issue type name (lowercased) -> id, for the configured project. */
  private issueTypeIds = new Map<string, string>();
  /** priority name (lowercased) -> id; empty when the instance has none. */
  private priorityIds = new Map<string, string>();
  /** Resolved component id for `cfg.tracker.project`, if set. */
  private componentId: string | null = null;

  constructor(auth: JiraAuth, cfg: CrewConfig, fetchImpl?: FetchLike) {
    this.client = new JiraClient(auth, fetchImpl);
    this.cfg = cfg;
    this.host = auth.host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }

  // --------------------------- meta / guards ------------------------------

  async resolveMeta(): Promise<TrackerMeta> {
    const projectKey = this.cfg.tracker.team;

    const project = await this.client.project(projectKey).catch((e) => {
      throw new Error(
        `Jira project not found: "${projectKey}". Use the project KEY (e.g. "BRI"), not its name. (${(e as Error).message})`,
      );
    });

    const [me, statuses, issueTypes] = await Promise.all([
      this.client.myself(),
      this.client.projectStatuses(project.key),
      this.client.issueTypes(project.key),
    ]);

    const stateIds: Record<string, string> = {};
    for (const s of statuses) stateIds[s.name] = s.id;

    for (const t of issueTypes) {
      this.issueTypeIds.set(t.name.toLowerCase(), t.id);
    }

    // Priority is optional per instance; if the field is unavailable we simply
    // never send it rather than failing every create.
    if (this.cfg.tracker.jira.usePriority) {
      const priorities = await this.client.priorities().catch(() => []);
      for (const p of priorities) this.priorityIds.set(p.name.toLowerCase(), p.id);
    }

    // Optional component scoping, so several repos can share one Jira project.
    if (this.cfg.tracker.project) {
      const want = this.cfg.tracker.project;
      const components = await this.client.components(project.key);
      const found = components.find((c) => c.name === want || c.id === want);
      if (!found) {
        throw new Error(
          `Jira component not found in project "${project.key}": "${want}". ` +
            `Create it in project settings, or drop \`tracker.project\` from your config.`,
        );
      }
      this.componentId = found.id;
    }

    this.verifyConfiguredNames(stateIds);

    // Jira labels have no ids — the name IS the identifier.
    const labelIds: Record<string, string> = {};
    for (const name of Object.values(this.cfg.tracker.labels)) {
      labelIds[name] = name;
    }

    this.meta = {
      teamId: project.key,
      myUserId: me.accountId,
      labelIds,
      stateIds,
      projectId: this.componentId ?? undefined,
    };
    return this.meta;
  }

  /**
   * Fail fast on statuses and issue types that don't exist in this project.
   * Without this the engine only discovers a typo mid-cycle, after it has
   * already moved an issue and spent an agent run on it.
   */
  private verifyConfiguredNames(stateIds: Record<string, string>): void {
    const S = this.cfg.tracker.statuses;
    const missingStatuses = Object.entries(S)
      .filter(([, name]) => !(name in stateIds))
      .map(([key, name]) => `${key}: "${name}"`);
    if (missingStatuses.length) {
      throw new Error(
        `Jira project "${this.cfg.tracker.team}" has no status named ` +
          `${missingStatuses.join(", ")}. Available: ${Object.keys(stateIds).join(", ")}. ` +
          `Fix tracker.statuses in your config to match the workflow.`,
      );
    }

    const types = this.cfg.tracker.jira.issueTypes;
    const missingTypes = [...new Set(Object.values(types))].filter(
      (name) => !this.issueTypeIds.has(name.toLowerCase()),
    );
    if (missingTypes.length) {
      throw new Error(
        `Jira project "${this.cfg.tracker.team}" has no issue type named ` +
          `${missingTypes.map((t) => `"${t}"`).join(", ")}. ` +
          `Available: ${[...this.issueTypeIds.keys()].join(", ")}. Fix tracker.jira.issueTypes.`,
      );
    }
  }

  private ensureMeta(): TrackerMeta {
    if (!this.meta) {
      throw new Error("JiraAdapter.resolveMeta() must be called before other methods");
    }
    return this.meta;
  }

  // ------------------------------- JQL ------------------------------------

  /** `project = X` plus the component clause, the prefix of every query. */
  private scope(): string {
    const parts = [`project = ${jql(this.cfg.tracker.team)}`];
    if (this.cfg.tracker.project) {
      parts.push(`component = ${jql(this.cfg.tracker.project)}`);
    }
    return parts.join(" AND ");
  }

  /**
   * JQL for the executable label gate, so an excluded item never occupies a
   * slot in the `maxResults: PAGE` window. `isExecutable` re-checks the same
   * rules client-side — this is an optimization, not the enforcement point.
   *
   * `labels not in (...)` is deliberately widened with `labels is EMPTY`:
   * in JQL a `not in` predicate is false for an issue with no labels at all,
   * which would silently exclude every unlabeled item from an exclude-only
   * config.
   */
  private labelClause(): string {
    const gate = this.cfg.tracker.executable;
    const parts: string[] = [];
    if (gate?.requireLabels?.length) {
      parts.push(`labels in (${gate.requireLabels.map((l) => jql(l)).join(", ")})`);
    }
    if (gate?.excludeLabels?.length) {
      const list = gate.excludeLabels.map((l) => jql(l)).join(", ");
      parts.push(`(labels is EMPTY OR labels not in (${list}))`);
    }
    return parts.length ? ` AND ${parts.join(" AND ")}` : "";
  }

  // ----------------------------- mapping ----------------------------------

  /**
   * Jira issue -> WorkItem.
   *
   * The type comes from the `type:*` label when present, and otherwise falls
   * back to the Jira issue type: work created in the Jira UI by a human won't
   * carry crew's labels, and treating it as untyped would make it invisible to
   * the executor.
   */
  private toWorkItem(issue: JiraIssue, parentStatusName?: string | null): WorkItem {
    const labels = issue.fields.labels ?? [];
    const type =
      labels.map((l) => labelNameToType(this.cfg.tracker, l)).find((t) => t !== null) ??
      this.issueTypeToItemType(issue.fields.issuetype?.name);

    const parent = issue.fields.parent ?? null;
    const parentState = parentStatusName ?? parent?.fields?.status?.name ?? null;
    const parentApproved = parent
      ? parentState !== null
        ? this.cfg.tracker.approvedStates.includes(parentState)
        : // A parent exists but its status didn't come back in this response.
          // Treat that as unapproved: the gate exists to stop unapproved work,
          // so an unknown answer must block rather than wave the item through.
          false
      : null;

    return {
      id: issue.key,
      identifier: issue.key,
      title: issue.fields.summary ?? "",
      description: adfToText(issue.fields.description),
      type,
      stateName: issue.fields.status?.name ?? "",
      priority: this.priorityNameToNumber(issue.fields.priority?.name),
      parentId: parent?.key ?? null,
      parentApproved,
      url: `https://${this.host}/browse/${issue.key}`,
      assigneeId: issue.fields.assignee?.accountId ?? null,
      labels,
      complexity: complexityFromLabels(labels),
    };
  }

  /** Map a Jira issue type name onto crew's ItemType, using the config map. */
  private issueTypeToItemType(name: string | undefined): ItemType | null {
    if (!name) return null;
    const t = this.cfg.tracker.jira.issueTypes;
    const lower = name.toLowerCase();
    // Check the more specific types before the generic "Task" fallbacks, since
    // several keys commonly map onto the same Jira type.
    if (lower === t.bug.toLowerCase()) return "bug";
    if (lower === t.prd.toLowerCase() && t.prd !== t.task) return "prd";
    if (lower === t.chore.toLowerCase() && t.chore !== t.task) return "chore-dx";
    if (lower === t.task.toLowerCase()) return "task";
    return null;
  }

  /** Named Jira priority -> the Linear-style number `WorkItem.priority` uses. */
  private priorityNameToNumber(name: string | undefined): number {
    if (!name) return 0;
    const p = this.cfg.tracker.jira.priorities;
    const lower = name.toLowerCase();
    if (lower === p.critical.toLowerCase()) return 1;
    if (lower === p.high.toLowerCase()) return 2;
    if (lower === p.medium.toLowerCase()) return 3;
    if (lower === p.low.toLowerCase()) return 4;
    return 0;
  }

  /** The priority field for a create, or {} when priority is off/unknown. */
  private priorityField(severity: Proposal["severity"]): Record<string, unknown> {
    if (!this.cfg.tracker.jira.usePriority) return {};
    const n = severityToPriority(severity);
    if (n === 0) return {};
    const p = this.cfg.tracker.jira.priorities;
    const name = n === 1 ? p.critical : n === 2 ? p.high : n === 3 ? p.medium : p.low;
    const id = this.priorityIds.get(name.toLowerCase());
    return id ? { priority: { id } } : {};
  }

  private issueTypeField(type: ItemType): Record<string, unknown> {
    const t = this.cfg.tracker.jira.issueTypes;
    const name =
      type === "bug" ? t.bug : type === "prd" ? t.prd : type === "chore-dx" ? t.chore : t.task;
    const id = this.issueTypeIds.get(name.toLowerCase());
    if (!id) {
      throw new Error(`Jira issue type "${name}" is not available on this project`);
    }
    return { issuetype: { id } };
  }

  // ---------------------------- selection ---------------------------------

  async selectNextExecutable(): Promise<WorkItem | null> {
    this.ensureMeta();

    const issues = await this.client.search(
      `${this.scope()} AND status = ${jql(this.cfg.tracker.statuses.ready)}` +
        `${this.labelClause()} ORDER BY priority DESC, created ASC`,
      { maxResults: PAGE },
    );

    const items = await this.withParentStatuses(issues);
    const executable = items.filter((i) => isExecutable(i, this.cfg));
    return rankCandidates(executable)[0] ?? null;
  }

  /**
   * Resolve each issue's parent status so `parentApproved` is accurate.
   *
   * Jira's search response carries `parent` but not the parent's status, and
   * that status is exactly what gates unapproved PRD work — so the parents get
   * fetched in one extra query (not one per child).
   */
  private async withParentStatuses(issues: JiraIssue[]): Promise<WorkItem[]> {
    const parentKeys = [
      ...new Set(issues.map((i) => i.fields.parent?.key).filter((k): k is string => !!k)),
    ];
    if (!parentKeys.length) return issues.map((i) => this.toWorkItem(i));

    const statusByKey = new Map<string, string>();
    const parents = await this.client
      .search(`key in (${parentKeys.map((k) => jql(k)).join(", ")})`, {
        maxResults: PAGE,
        fields: ["status", "summary"],
      })
      .catch(() => [] as JiraIssue[]);
    for (const p of parents) {
      if (p.fields.status?.name) statusByKey.set(p.key, p.fields.status.name);
    }

    return issues.map((i) => {
      const pk = i.fields.parent?.key;
      return this.toWorkItem(i, pk ? (statusByKey.get(pk) ?? null) : null);
    });
  }

  async countInProgress(): Promise<number> {
    this.ensureMeta();
    return this.client.count(
      `${this.scope()} AND status = ${jql(this.cfg.tracker.statuses.inProgress)}`,
    );
  }

  async countBacklog(): Promise<number> {
    this.ensureMeta();
    return this.client.count(
      `${this.scope()} AND status = ${jql(this.cfg.tracker.statuses.backlog)}`,
    );
  }

  // --------------------------- mutations ----------------------------------

  /**
   * Move an issue to a named status.
   *
   * Jira has no "set status" call: you must POST a transition that is legal
   * from where the issue currently sits. If the workflow offers no such path,
   * that's a real workflow misconfiguration and is surfaced as an error naming
   * what *was* available.
   */
  async transition(issueId: string, toStateName: string): Promise<void> {
    this.ensureMeta();

    const available = await this.client.transitions(issueId);
    const match =
      available.find((t) => t.to?.name === toStateName) ??
      available.find((t) => t.name === toStateName);

    if (!match) {
      const current = await this.client
        .issue(issueId)
        .then((i) => i.fields.status?.name ?? "unknown")
        .catch(() => "unknown");
      // Already there: treat as success so a retry after a partial failure is
      // idempotent rather than fatal.
      if (current === toStateName) return;
      throw new Error(
        `Jira: no workflow transition from "${current}" to "${toStateName}" on ${issueId}. ` +
          `Available: ${available.map((t) => `${t.name} → ${t.to?.name}`).join(", ") || "none"}.`,
      );
    }

    await this.client.transition(issueId, match.id);
  }

  async assign(issueId: string, userId: string | null): Promise<void> {
    this.ensureMeta();
    await this.client.assign(issueId, userId);
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

    const labels = [
      typeToLabelName(this.cfg.tracker, proposal.type),
      AGENT_AUTHORED_LABEL,
      `agent:${opts.author}`,
    ];
    if (proposal.complexity) labels.push(`${COMPLEXITY_PREFIX}${proposal.complexity}`);
    if (opts.label?.trim()) labels.push(opts.label.trim());

    const created = await this.client.createIssue({
      project: { key: meta.teamId },
      summary: proposal.title,
      description: textToAdf(proposal.body),
      labels: [...new Set(labels.map(jiraLabel))],
      ...this.issueTypeField(proposal.type),
      ...this.priorityField(proposal.severity),
      ...(this.componentId ? { components: [{ id: this.componentId }] } : {}),
      ...(opts.parentId ? { parent: { key: opts.parentId } } : {}),
    });

    // Jira creates every issue in its workflow's initial status, which is rarely
    // the one we want — so move it afterwards. A workflow with no path from the
    // initial status is a config problem, but it must not lose the created
    // issue, so the failure is reported without discarding the work.
    const target = opts.needsApproval
      ? this.cfg.tracker.statuses.needsApproval
      : this.cfg.tracker.statuses.backlog;
    await this.transition(created.key, target).catch((e) => {
      throw new Error(
        `Created ${created.key} but could not move it to "${target}": ${(e as Error).message}`,
      );
    });

    return this.fetchWorkItem(created.key);
  }

  async createSubIssues(parentId: string, proposals: Proposal[]): Promise<WorkItem[]> {
    const meta = this.ensureMeta();
    const ready = this.cfg.tracker.statuses.ready;
    const subtaskType = this.cfg.tracker.jira.subtaskIssueType;

    const out: WorkItem[] = [];
    for (const proposal of proposals) {
      const typeField = subtaskType
        ? { issuetype: { id: this.issueTypeIdOrThrow(subtaskType) } }
        : this.issueTypeField(proposal.type);

      const created = await this.client.createIssue({
        project: { key: meta.teamId },
        summary: proposal.title,
        description: textToAdf(proposal.body),
        labels: [jiraLabel(typeToLabelName(this.cfg.tracker, proposal.type))],
        ...typeField,
        ...this.priorityField(proposal.severity),
        ...(this.componentId ? { components: [{ id: this.componentId }] } : {}),
        parent: { key: parentId },
      });

      await this.transition(created.key, ready).catch((e) => {
        throw new Error(
          `Created sub-issue ${created.key} but could not move it to "${ready}": ${(e as Error).message}`,
        );
      });
      out.push(await this.fetchWorkItem(created.key));
    }
    return out;
  }

  private issueTypeIdOrThrow(name: string): string {
    const id = this.issueTypeIds.get(name.toLowerCase());
    if (!id) {
      throw new Error(
        `Jira issue type "${name}" is not available on project "${this.cfg.tracker.team}"`,
      );
    }
    return id;
  }

  private async fetchWorkItem(key: string): Promise<WorkItem> {
    const issue = await this.client.issue(key);
    const parentKey = issue.fields.parent?.key;
    let parentStatus: string | null = null;
    if (parentKey && !issue.fields.parent?.fields?.status?.name) {
      parentStatus = await this.client
        .issue(parentKey)
        .then((p) => p.fields.status?.name ?? null)
        .catch(() => null);
    }
    return this.toWorkItem(issue, parentStatus);
  }

  /**
   * Dedup candidates: everything still open, plus work that is already done or
   * was rejected — mirroring the Linear adapter so both trackers refuse to
   * re-file the same work.
   *
   * Completed work only counts for `dedupLookbackDays`; a bug fixed a year ago
   * can legitimately regress. Canceled work has no window: canceling an issue
   * is how a human says "don't do this", and that doesn't expire on a timer.
   */
  async findSimilarOpen(title: string): Promise<WorkItem[]> {
    this.ensureMeta();

    // Jira has no "canceled" status category — closing as Won't Do / Duplicate
    // is a *resolution* on a Done-category status. So "rejected" is expressed
    // as a resolution test, and only genuinely-completed work gets the window.
    const days = this.cfg.triager.dedupLookbackDays;
    const clauses = [
      "statusCategory != Done",
      `(statusCategory = Done AND resolutiondate >= -${days}d)`,
      `resolution in ("Won't Do", "Duplicate", "Declined", "Rejected")`,
    ];
    // Named resolutions vary by instance, and JQL rejects the entire query if
    // one doesn't exist. Fall back to the open-plus-recent query so dedup keeps
    // working rather than erroring on every proposal.
    const issues = await this.client
      .search(`${this.scope()} AND (${clauses.join(" OR ")})`, { maxResults: PAGE })
      .catch(() =>
        this.client.search(
          `${this.scope()} AND (${clauses.slice(0, 2).join(" OR ")})`,
          { maxResults: PAGE },
        ),
      );

    const threshold = this.cfg.triager.dedupThreshold ?? DEDUP_THRESHOLD;
    return issues
      .filter((i) => isDuplicate(title, i.fields.summary ?? "", threshold))
      .map((i) => this.toWorkItem(i));
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.addComment(issueId, body);
  }

  async markDuplicate(issueId: string, ofIdentifier: string): Promise<void> {
    this.ensureMeta();
    await this.addComment(issueId, `Marked as duplicate of ${ofIdentifier}.`);

    // The link is the part that matters and is safe to attempt on its own; a
    // Jira instance may not have the "Duplicate" link type configured.
    await this.client.link(issueId, ofIdentifier, "Duplicates").catch(() => {});

    // Then close it, if the workflow allows it from here.
    const done = this.cfg.tracker.statuses.done;
    await this.transition(issueId, done).catch(() => {});
  }
}

/**
 * Quote a value for JQL. Jira treats `"` and `\` specially inside quoted
 * strings, so both must be escaped — a status name like `Won"t Do` would
 * otherwise produce a syntax error or, worse, a query that means something
 * else.
 */
function jql(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Jira labels may not contain whitespace — the API rejects the whole create if
 * one does. crew's own labels are already safe, but an agent's configured
 * `label` option is user input, so spaces collapse to hyphens.
 */
export function jiraLabel(name: string): string {
  return name.trim().replace(/\s+/g, "-");
}
