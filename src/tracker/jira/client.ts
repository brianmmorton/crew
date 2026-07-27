/**
 * A minimal Jira Cloud REST client — only the dozen or so calls `JiraAdapter`
 * actually makes.
 *
 * Hand-rolled on `fetch` rather than pulling in a Jira SDK: crew has five
 * runtime dependencies and the surface used here is small and stable. The
 * `fetchImpl` seam exists so tests can drive the adapter without a network.
 */

/** Credentials for Jira Cloud (Basic auth with an Atlassian API token). */
export interface JiraAuth {
  /** Site host, e.g. "acme.atlassian.net" (no scheme, no trailing slash). */
  host: string;
  /** Atlassian account email the token belongs to. */
  email: string;
  /** API token from id.atlassian.com/manage-profile/security/api-tokens. */
  apiToken: string;
}

/** The subset of `fetch` this client uses, so tests can substitute a fake. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class JiraError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JiraError";
    this.status = status;
  }
}

// ------------------------------ API shapes ---------------------------------
// Only the fields crew reads. Jira returns far more on every issue.

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { id: string; name: string; statusCategory?: { key: string } };
    priority?: { id: string; name: string } | null;
    labels?: string[];
    issuetype?: { id: string; name: string; subtask?: boolean };
    assignee?: { accountId: string } | null;
    parent?: { id: string; key: string; fields?: { status?: { name: string } } } | null;
    resolutiondate?: string | null;
    components?: Array<{ id: string; name: string }>;
  };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { id: string; name: string };
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory?: { key: string };
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraComponent {
  id: string;
  name: string;
}

export interface JiraPriority {
  id: string;
  name: string;
}

export class JiraClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;

  constructor(auth: JiraAuth, fetchImpl?: FetchLike) {
    const host = auth.host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.base = `https://${host}/rest/api/3`;
    this.authHeader =
      "Basic " + Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64");
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!this.fetchImpl) {
      throw new Error("global fetch is unavailable — crew requires Node 20+");
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await res.text();
    if (!res.ok) {
      // Jira reports failures as {errorMessages:[], errors:{field:msg}}. Surface
      // both, since field errors are what actually explain a rejected create.
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as {
          errorMessages?: string[];
          errors?: Record<string, string>;
        };
        const parts = [
          ...(parsed.errorMessages ?? []),
          ...Object.entries(parsed.errors ?? {}).map(([k, v]) => `${k}: ${v}`),
        ];
        if (parts.length) detail = parts.join("; ");
      } catch {
        /* keep the raw body */
      }
      throw new JiraError(res.status, `Jira ${method} ${path} failed (${res.status}): ${detail}`);
    }

    // 204 No Content — transitions, assignment, and updates all return empty.
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ------------------------------ reads ------------------------------------

  /** The authenticated user (used to resolve `myUserId`). */
  async myself(): Promise<{ accountId: string; displayName?: string }> {
    return this.request("GET", "/myself");
  }

  async project(keyOrId: string): Promise<{ id: string; key: string; name: string }> {
    return this.request("GET", `/project/${encodeURIComponent(keyOrId)}`);
  }

  /** Every status available on a project, across its issue types. */
  async projectStatuses(keyOrId: string): Promise<JiraStatus[]> {
    const byType = await this.request<Array<{ statuses: JiraStatus[] }>>(
      "GET",
      `/project/${encodeURIComponent(keyOrId)}/statuses`,
    );
    const seen = new Map<string, JiraStatus>();
    for (const t of byType) {
      for (const s of t.statuses ?? []) {
        if (!seen.has(s.name)) seen.set(s.name, s);
      }
    }
    return [...seen.values()];
  }

  async issueTypes(projectKeyOrId: string): Promise<JiraIssueType[]> {
    const proj = await this.request<{ issueTypes?: JiraIssueType[] }>(
      "GET",
      `/project/${encodeURIComponent(projectKeyOrId)}?expand=issueTypes`,
    );
    return proj.issueTypes ?? [];
  }

  async components(projectKeyOrId: string): Promise<JiraComponent[]> {
    return this.request("GET", `/project/${encodeURIComponent(projectKeyOrId)}/components`);
  }

  async priorities(): Promise<JiraPriority[]> {
    return this.request("GET", "/priority");
  }

  /**
   * Run a JQL search, following pagination until `limit` issues are collected.
   *
   * Uses `/search/jql`; the old `/search` was removed by Atlassian in 2025
   * (CHANGE-2046) and now returns 410. Three behaviours differ from it and are
   * handled here:
   *
   * - Paging is by opaque `nextPageToken`, not `startAt`, and the page size the
   *   server actually returns may be smaller than asked for — so "did I get
   *   everything?" is answered by `isLast`, never by counting rows.
   * - There is no `total` in the response; see `count()`.
   * - `maxResults` must be 1..5000; 0 is a 400.
   */
  async search(
    jql: string,
    opts: { maxResults?: number; fields?: string[] } = {},
  ): Promise<JiraIssue[]> {
    const limit = Math.max(1, Math.min(opts.maxResults ?? 100, 5000));
    const fields = opts.fields ?? [
      "summary",
      "description",
      "status",
      "priority",
      "labels",
      "issuetype",
      "assignee",
      "parent",
      "components",
    ];

    const out: JiraIssue[] = [];
    let nextPageToken: string | undefined;

    do {
      const res = await this.request<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>("POST", "/search/jql", {
        jql,
        maxResults: Math.min(limit - out.length, 5000),
        fields,
        ...(nextPageToken ? { nextPageToken } : {}),
      });

      out.push(...(res.issues ?? []));
      // `isLast` is absent on some responses; a missing token also means done.
      nextPageToken = res.isLast === true ? undefined : res.nextPageToken;
    } while (nextPageToken && out.length < limit);

    return out.slice(0, limit);
  }

  /**
   * Count matches. `/search/jql` returns no `total`, so this uses the dedicated
   * approximate-count endpoint. The value is approximate by design — it drives
   * the WIP/backlog caps, where being off by one near a threshold is
   * inconsequential.
   */
  async count(jql: string): Promise<number> {
    const res = await this.request<{ count?: number }>(
      "POST",
      "/search/approximate-count",
      { jql },
    );
    return res.count ?? 0;
  }

  async issue(idOrKey: string): Promise<JiraIssue> {
    return this.request("GET", `/issue/${encodeURIComponent(idOrKey)}`);
  }

  async transitions(idOrKey: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions?: JiraTransition[] }>(
      "GET",
      `/issue/${encodeURIComponent(idOrKey)}/transitions`,
    );
    return res.transitions ?? [];
  }

  // ----------------------------- mutations ---------------------------------

  async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
    return this.request("POST", "/issue", { fields });
  }

  async updateIssue(idOrKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `/issue/${encodeURIComponent(idOrKey)}`, { fields });
  }

  async transition(idOrKey: string, transitionId: string): Promise<void> {
    await this.request("POST", `/issue/${encodeURIComponent(idOrKey)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  async assign(idOrKey: string, accountId: string | null): Promise<void> {
    await this.request("PUT", `/issue/${encodeURIComponent(idOrKey)}/assignee`, {
      accountId,
    });
  }

  async addComment(idOrKey: string, body: string): Promise<void> {
    await this.request("POST", `/issue/${encodeURIComponent(idOrKey)}/comment`, {
      body: textToAdf(body),
    });
  }

  /** Link two issues (used to record duplicates). */
  async link(
    inwardKey: string,
    outwardKey: string,
    linkType = "Duplicate",
  ): Promise<void> {
    await this.request("POST", "/issueLink", {
      type: { name: linkType },
      inwardIssue: { key: inwardKey },
      outwardIssue: { key: outwardKey },
    });
  }
}

// ------------------------------ ADF helpers --------------------------------

/**
 * Wrap plain text/markdown in an Atlassian Document Format doc.
 *
 * The v3 API rejects plain strings for rich-text fields. Agents emit markdown,
 * and faithfully converting markdown to ADF is a project in itself — so each
 * blank-line-separated block becomes one paragraph, which keeps the text
 * readable and never loses content. Markdown syntax renders literally.
 */
export function textToAdf(text: string): Record<string, unknown> {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim() !== "");
  const content = (blocks.length ? blocks : [""]).map((block) => ({
    type: "paragraph",
    content: block.trim()
      ? // ADF forbids literal newlines inside a text node; use hardBreak marks.
        block
          .split("\n")
          .flatMap((line, i) =>
            i === 0
              ? [{ type: "text", text: line }]
              : [{ type: "hardBreak" }, { type: "text", text: line }],
          )
          .filter((n) => n.type !== "text" || (n as { text: string }).text !== "")
      : [],
  }));
  return { type: "doc", version: 1, content };
}

/** Flatten an ADF document (or plain string) back to text for the engine. */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!doc || typeof doc !== "object") return "";

  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: string;
      text?: string;
      content?: unknown[];
    };
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    else if (n.type === "hardBreak") out.push("\n");
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      // Block-level nodes end with a blank line so paragraphs stay separated.
      if (n.type === "paragraph" || n.type === "heading") out.push("\n\n");
    }
  };
  walk(doc);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}
