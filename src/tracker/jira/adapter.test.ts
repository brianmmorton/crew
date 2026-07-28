import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraAdapter, jiraLabel } from "./adapter.js";
import { JiraClient, adfToText, textToAdf, type FetchLike } from "./client.js";
import type { CrewConfig, Proposal } from "../../types.js";

/**
 * These exercise the parts of the Jira adapter that have no Linear counterpart
 * and therefore no existing coverage: status changes going through workflow
 * transitions, the parent-approval gate when Jira omits the parent's status,
 * and markdown <-> ADF round-tripping.
 */

const cfg = {
  tracker: {
    provider: "jira",
    team: "BRI",
    labels: { prd: "type:prd", bug: "type:bug", task: "type:task", chore: "type:chore-dx" },
    statuses: {
      backlog: "Backlog",
      ready: "Todo",
      inProgress: "In Progress",
      review: "In Review",
      needsApproval: "Needs Approval",
      done: "Done",
    },
    approvedStates: ["Todo", "In Progress", "In Review", "Done"],
    autoPromote: true,
    jira: {
      issueTypes: { prd: "Task", bug: "Bug", task: "Task", chore: "Task" },
      usePriority: true,
      priorities: { critical: "Highest", high: "High", medium: "Medium", low: "Low" },
    },
  },
  triager: { dedupThreshold: 0.85, dedupLookbackDays: 30, backlogCap: 30 },
} as unknown as CrewConfig;

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * A fake Jira REST endpoint. `routes` maps "METHOD /path-prefix" to a response
 * body; anything unmatched returns {} so a test only declares what it cares
 * about.
 */
function fakeFetch(routes: Record<string, unknown>): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace(/^https:\/\/[^/]+\/rest\/api\/3/, "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    // Prefer an exact match, so "GET /issue/BRI-1" can't shadow
    // "GET /issue/BRI-1/transitions"; fall back to longest prefix.
    const candidates = Object.keys(routes).filter((k) => {
      const [m, p] = k.split(" ");
      return m === method && (path === p || path.startsWith(p));
    });
    const key = candidates.sort(
      (a, b) => b.split(" ")[1].length - a.split(" ")[1].length,
    )[0];
    const payload = key ? routes[key] : {};
    if (payload instanceof Error) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ errorMessages: [payload.message] }) };
    }
    // The removed /search endpoint now answers 410 — mirror that so a
    // regression back onto it fails loudly here instead of in production.
    if (path === "/search") {
      return {
        ok: false,
        status: 410,
        text: async () =>
          JSON.stringify({
            errorMessages: ["The requested API has been removed. Please migrate to the /rest/api/3/search/jql API."],
          }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

const auth = { host: "acme.atlassian.net", email: "a@b.c", apiToken: "t" };

/** An adapter with `resolveMeta()` already satisfied, so tests skip discovery. */
function primed(routes: Record<string, unknown>, config: CrewConfig = cfg) {
  const { fetchImpl, calls } = fakeFetch(routes);
  const adapter = new JiraAdapter(auth, config, fetchImpl);
  (adapter as unknown as { meta: unknown }).meta = {
    teamId: "BRI",
    myUserId: "acct-1",
    labelIds: {},
    stateIds: { Todo: "1", "In Progress": "2", Backlog: "3" },
  };
  return { adapter, calls };
}

// ----------------------------- transitions ---------------------------------

test("transition resolves the target status to a workflow transition id", async () => {
  const { adapter, calls } = primed({
    "GET /issue/BRI-1/transitions": {
      transitions: [
        { id: "11", name: "Start", to: { id: "2", name: "In Progress" } },
        { id: "21", name: "Done", to: { id: "9", name: "Done" } },
      ],
    },
  });

  await adapter.transition("BRI-1", "In Progress");

  const post = calls.find((c) => c.method === "POST");
  assert.equal(post?.path, "/issue/BRI-1/transitions");
  assert.deepEqual(post?.body, { transition: { id: "11" } });
});

test("transition to the status an issue is already in is a no-op, not an error", async () => {
  // Jira offers no transition to the current status, so a naive lookup fails.
  // Retries after a partial failure depend on this being idempotent.
  const { adapter, calls } = primed({
    "GET /issue/BRI-1/transitions": { transitions: [] },
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: { summary: "x", status: { id: "1", name: "Todo" } } },
  });

  await adapter.transition("BRI-1", "Todo");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("transition with no legal path reports what the workflow does allow", async () => {
  const { adapter } = primed({
    "GET /issue/BRI-1/transitions": {
      transitions: [{ id: "11", name: "Start", to: { id: "2", name: "In Progress" } }],
    },
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: { summary: "x", status: { id: "1", name: "Todo" } } },
  });

  await assert.rejects(
    () => adapter.transition("BRI-1", "Done"),
    (e: Error) => e.message.includes("Start → In Progress") && e.message.includes('"Todo"'),
  );
});

// --------------------------- label gate (JQL) ------------------------------

/** cfg plus an executable label gate. */
function gatedCfg(gate: { requireLabels?: string[]; excludeLabels?: string[] }): CrewConfig {
  return {
    ...cfg,
    tracker: {
      ...(cfg as unknown as { tracker: Record<string, unknown> }).tracker,
      executable: { requireLabels: [], excludeLabels: [], ...gate },
    },
  } as unknown as CrewConfig;
}

/** Capture the JQL selectNextExecutable issues, with a stubbed empty result. */
function captureJql(config: CrewConfig): { adapter: JiraAdapter; jqls: string[] } {
  const { adapter } = primed({}, config);
  const jqls: string[] = [];
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async (q: string) => {
      jqls.push(q);
      return [];
    },
  };
  return { adapter, jqls };
}

test("selectNextExecutable adds no label clause when the gate is unset", async () => {
  const { adapter, jqls } = captureJql(cfg);
  await adapter.selectNextExecutable();
  assert.equal(jqls.length, 1);
  assert.ok(!jqls[0].includes("labels"), jqls[0]);
});

test("selectNextExecutable pushes requireLabels into the JQL", async () => {
  const { adapter, jqls } = captureJql(gatedCfg({ requireLabels: ["crew", "agent-ok"] }));
  await adapter.selectNextExecutable();
  assert.ok(jqls[0].includes('labels in ("crew", "agent-ok")'), jqls[0]);
});

test("excludeLabels JQL still matches issues that have no labels at all", async () => {
  const { adapter, jqls } = captureJql(gatedCfg({ excludeLabels: ["blocked"] }));
  await adapter.selectNextExecutable();
  // Bare `labels not in (...)` is false for an unlabeled issue in JQL, which
  // would wrongly exclude all unlabeled work from an exclude-only config.
  assert.ok(jqls[0].includes('(labels is EMPTY OR labels not in ("blocked"))'), jqls[0]);
});

test("label clause sits before ORDER BY and quotes values", async () => {
  const { adapter, jqls } = captureJql(gatedCfg({ requireLabels: ['we"ird'] }));
  await adapter.selectNextExecutable();
  const q = jqls[0];
  assert.ok(q.indexOf("labels in") < q.indexOf("ORDER BY"), q);
  assert.ok(q.includes('"we\\"ird"'), q);
});

test("selectNextExecutable still drops an excluded item the server returned", async () => {
  // Belt-and-braces: the JQL narrows the page, but isExecutable is the
  // enforcement point, so a server that ignores the clause changes nothing.
  const { adapter } = primed({}, gatedCfg({ excludeLabels: ["blocked"] }));
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async () => [
      {
        id: "1",
        key: "BRI-10",
        fields: {
          summary: "blocked work",
          status: { id: "1", name: "Todo" },
          labels: ["type:task", "blocked"],
        },
      },
    ],
  };
  assert.equal(await adapter.selectNextExecutable(), null);
});

// -------------------------- parent approval gate ---------------------------

test("selectNextExecutable blocks a child whose parent PRD is unapproved", async () => {
  const { adapter } = primed({
    "POST /search": null, // replaced per-call below
  });

  // Jira's search response carries `parent` but not the parent's status, so the
  // adapter must fetch parents separately — that second query is what decides
  // whether the item is gated.
  let call = 0;
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async () => {
      call++;
      if (call === 1) {
        return [
          {
            id: "1",
            key: "BRI-10",
            fields: {
              summary: "child",
              status: { id: "1", name: "Todo" },
              labels: ["type:task"],
              parent: { id: "9", key: "BRI-9" },
            },
          },
        ];
      }
      return [{ id: "9", key: "BRI-9", fields: { summary: "prd", status: { id: "5", name: "Needs Approval" } } }];
    },
  };

  assert.equal(await adapter.selectNextExecutable(), null);
});

test("selectNextExecutable allows a child whose parent PRD is approved", async () => {
  const { adapter } = primed({});
  let call = 0;
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async () => {
      call++;
      if (call === 1) {
        return [
          {
            id: "1",
            key: "BRI-10",
            fields: {
              summary: "child",
              status: { id: "1", name: "Todo" },
              labels: ["type:task"],
              parent: { id: "9", key: "BRI-9" },
            },
          },
        ];
      }
      return [{ id: "9", key: "BRI-9", fields: { summary: "prd", status: { id: "1", name: "Todo" } } }];
    },
  };

  const item = await adapter.selectNextExecutable();
  assert.equal(item?.identifier, "BRI-10");
  assert.equal(item?.parentApproved, true);
});

test("an unresolvable parent status blocks the item rather than waving it through", async () => {
  const { adapter } = primed({});
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async (jql: string) =>
      jql.startsWith("key in")
        ? [] // the parent lookup came back empty
        : [
            {
              id: "1",
              key: "BRI-10",
              fields: {
                summary: "child",
                status: { id: "1", name: "Todo" },
                labels: ["type:task"],
                parent: { id: "9", key: "BRI-9" },
              },
            },
          ],
  };

  assert.equal(await adapter.selectNextExecutable(), null);
});

// --------------------------- search / count API ----------------------------
// Atlassian removed POST /search (CHANGE-2046); it answers 410. The replacement
// pages by opaque token, returns no `total`, and rejects maxResults:0.

test("search uses /search/jql, never the removed /search endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST /search/jql": { issues: [{ id: "1", key: "BRI-1", fields: { summary: "a" } }], isLast: true },
  });
  const client = new JiraClient(auth, fetchImpl);

  const out = await client.search("project = BRI");
  assert.equal(out.length, 1);
  assert.deepEqual(calls.map((c) => c.path), ["/search/jql"]);
});

test("count uses approximate-count, since /search/jql returns no total", async () => {
  const { fetchImpl, calls } = fakeFetch({ "POST /search/approximate-count": { count: 42 } });
  const client = new JiraClient(auth, fetchImpl);

  assert.equal(await client.count("project = BRI"), 42);
  assert.deepEqual(calls.map((c) => c.path), ["/search/approximate-count"]);
});

test("count never sends maxResults:0, which the API rejects as out of range", async () => {
  const { fetchImpl, calls } = fakeFetch({ "POST /search/approximate-count": { count: 3 } });
  await new JiraClient(auth, fetchImpl).count("project = BRI");
  assert.equal(
    calls.every((c) => (c.body as Record<string, unknown>)?.maxResults === undefined),
    true,
  );
});

test("search follows nextPageToken until isLast", async () => {
  let page = 0;
  const fetchImpl: FetchLike = async (_url, init) => {
    page++;
    const body = init?.body ? JSON.parse(init.body) : {};
    const res =
      page === 1
        ? { issues: [{ id: "1", key: "BRI-1", fields: { summary: "a" } }], nextPageToken: "tok-2", isLast: false }
        : { issues: [{ id: "2", key: "BRI-2", fields: { summary: "b" } }], isLast: true };
    // The second request must echo the token from the first.
    if (page === 2) assert.equal(body.nextPageToken, "tok-2");
    return { ok: true, status: 200, text: async () => JSON.stringify(res) };
  };

  const out = await new JiraClient(auth, fetchImpl).search("project = BRI", { maxResults: 10 });
  assert.deepEqual(out.map((i) => i.key), ["BRI-1", "BRI-2"]);
});

test("search stops at the requested limit instead of paging forever", async () => {
  // A server that always claims there is another page: only `maxResults` ends it.
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        issues: [{ id: "x", key: "BRI-X", fields: { summary: "s" } }],
        nextPageToken: "always-more",
        isLast: false,
      }),
  });

  const out = await new JiraClient(auth, fetchImpl).search("project = BRI", { maxResults: 3 });
  assert.equal(out.length, 3);
});

test("a 410 from the removed endpoint surfaces Atlassian's migration message", async () => {
  const { fetchImpl } = fakeFetch({});
  const client = new JiraClient(auth, fetchImpl);
  // Reach past the typed surface to prove the error path itself is intact.
  await assert.rejects(
    () => (client as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> })
      .request("POST", "/search", { jql: "x" }),
    (e: Error) => e.message.includes("410") && e.message.includes("/rest/api/3/search/jql"),
  );
});

// ------------------------------- creates -----------------------------------

test("createIssue sends a real issue type, sanitized labels, and a mapped priority", async () => {
  const { adapter, calls } = primed({
    "POST /issue": { id: "100", key: "BRI-100" },
    "GET /issue/BRI-100": {
      id: "100",
      key: "BRI-100",
      fields: { summary: "t", status: { id: "3", name: "Backlog" }, labels: [] },
    },
    "GET /issue/BRI-100/transitions": {
      transitions: [{ id: "31", name: "To Backlog", to: { id: "3", name: "Backlog" } }],
    },
  });
  (adapter as unknown as { issueTypeIds: Map<string, string> }).issueTypeIds = new Map([
    ["bug", "10004"],
  ]);
  (adapter as unknown as { priorityIds: Map<string, string> }).priorityIds = new Map([
    ["highest", "1"],
  ]);

  const proposal: Proposal = {
    type: "bug",
    title: "Crash on save",
    body: "Steps:\n\n1. do it",
    severity: "critical",
    isMaterial: false,
  };
  await adapter.createIssue(proposal, { author: "qa", label: "agent qa" });

  const create = calls.find((c) => c.method === "POST" && c.path === "/issue");
  const fields = (create?.body as { fields: Record<string, unknown> }).fields;
  assert.deepEqual(fields.issuetype, { id: "10004" });
  assert.deepEqual(fields.priority, { id: "1" });
  // Jira rejects labels containing whitespace.
  assert.deepEqual(fields.labels, ["type:bug", "agent-authored", "agent:qa", "agent-qa"]);
});

test("createIssue omits priority entirely when the instance has it disabled", async () => {
  const noPriority = {
    ...cfg,
    tracker: { ...cfg.tracker, jira: { ...cfg.tracker.jira, usePriority: false } },
  } as unknown as CrewConfig;
  const { fetchImpl, calls } = fakeFetch({
    "POST /issue": { id: "1", key: "BRI-1" },
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: { summary: "t", labels: [] } },
    "GET /issue/BRI-1/transitions": {
      transitions: [{ id: "31", name: "x", to: { id: "3", name: "Backlog" } }],
    },
  });
  const adapter = new JiraAdapter(auth, noPriority, fetchImpl);
  (adapter as unknown as { meta: unknown }).meta = {
    teamId: "BRI",
    myUserId: "u",
    labelIds: {},
    stateIds: {},
  };
  (adapter as unknown as { issueTypeIds: Map<string, string> }).issueTypeIds = new Map([
    ["task", "10001"],
  ]);

  await adapter.createIssue(
    { type: "task", title: "t", body: "b", severity: "high", isMaterial: false },
    { author: "qa" },
  );

  const fields = (calls.find((c) => c.path === "/issue")?.body as { fields: Record<string, unknown> })
    .fields;
  assert.equal("priority" in fields, false);
});

// ------------------------------ ADF mapping --------------------------------

test("textToAdf splits blank-line-separated blocks into paragraphs", () => {
  const doc = textToAdf("First para.\n\nSecond para.") as {
    content: Array<{ type: string }>;
  };
  assert.equal(doc.content.length, 2);
  assert.equal(doc.content[0].type, "paragraph");
});

test("single newlines inside a block become hardBreaks, never literal \\n text", () => {
  // ADF text nodes may not contain newlines; Jira rejects the document if they do.
  const doc = textToAdf("line one\nline two") as {
    content: Array<{ content: Array<{ type: string; text?: string }> }>;
  };
  const nodes = doc.content[0].content;
  assert.deepEqual(
    nodes.map((n) => n.type),
    ["text", "hardBreak", "text"],
  );
  assert.equal(nodes.every((n) => !n.text?.includes("\n")), true);
});

test("adfToText recovers the paragraph structure it was built from", () => {
  const original = "Title line\n\nA second paragraph.";
  assert.equal(adfToText(textToAdf(original)), original);
});

test("adfToText passes a plain string through, for older/plain descriptions", () => {
  assert.equal(adfToText("just text"), "just text");
});

test("adfToText on an empty or missing description yields an empty string", () => {
  assert.equal(adfToText(undefined), "");
  assert.equal(adfToText(textToAdf("")), "");
});

test("textToAdf turns a heading into a heading node with the right level", () => {
  const doc = textToAdf("## Section") as {
    content: Array<{ type: string; attrs?: { level: number } }>;
  };
  assert.equal(doc.content[0].type, "heading");
  assert.equal(doc.content[0].attrs?.level, 2);
});

test("textToAdf turns bold, italic, and inline code into marked text nodes", () => {
  const doc = textToAdf("**bold** and *italic* and `code`") as {
    content: Array<{ content: Array<{ text: string; marks?: Array<{ type: string }> }> }>;
  };
  const nodes = doc.content[0].content;
  assert.equal(nodes.find((n) => n.text === "bold")?.marks?.[0].type, "strong");
  assert.equal(nodes.find((n) => n.text === "italic")?.marks?.[0].type, "em");
  assert.equal(nodes.find((n) => n.text === "code")?.marks?.[0].type, "code");
});

test("textToAdf turns a markdown link into a link mark", () => {
  const doc = textToAdf("see [docs](https://example.com)") as {
    content: Array<{ content: Array<{ text: string; marks?: Array<{ type: string; attrs?: { href: string } }> }> }>;
  };
  const link = doc.content[0].content.find((n) => n.text === "docs");
  assert.equal(link?.marks?.[0].type, "link");
  assert.equal(link?.marks?.[0].attrs?.href, "https://example.com");
});

test("textToAdf turns a bullet list into a bulletList of listItems", () => {
  const doc = textToAdf("- one\n- two") as {
    content: Array<{ type: string; content?: unknown[] }>;
  };
  assert.equal(doc.content[0].type, "bulletList");
  assert.equal(doc.content[0].content?.length, 2);
});

test("textToAdf turns a numbered list into an orderedList", () => {
  const doc = textToAdf("1. one\n2. two") as {
    content: Array<{ type: string; content?: unknown[] }>;
  };
  assert.equal(doc.content[0].type, "orderedList");
  assert.equal(doc.content[0].content?.length, 2);
});

test("textToAdf turns a fenced code block into a codeBlock node", () => {
  const doc = textToAdf("```ts\nconst x = 1;\n```") as {
    content: Array<{ type: string; attrs?: { language: string }; content: Array<{ text: string }> }>;
  };
  assert.equal(doc.content[0].type, "codeBlock");
  assert.equal(doc.content[0].attrs?.language, "ts");
  assert.equal(doc.content[0].content[0].text, "const x = 1;");
});

test("textToAdf turns a blockquote into a blockquote node", () => {
  const doc = textToAdf("> quoted text") as { content: Array<{ type: string }> };
  assert.equal(doc.content[0].type, "blockquote");
});

test("adfToText recovers a plain-text-readable form of a formatted doc", () => {
  const doc = textToAdf("## Title\n\n- one\n- two\n\nSome **bold** text.");
  const text = adfToText(doc);
  assert.match(text, /Title/);
  assert.match(text, /one/);
  assert.match(text, /two/);
  assert.match(text, /bold/);
});

// ------------------------------- labels ------------------------------------

test("jiraLabel collapses whitespace so Jira accepts the label", () => {
  assert.equal(jiraLabel("agent product"), "agent-product");
  assert.equal(jiraLabel("  spaced  out  "), "spaced-out");
  assert.equal(jiraLabel("type:bug"), "type:bug");
});

test("explainEmptySelection makes no query when no gate is configured", async () => {
  const { adapter } = primed({}, cfg);
  let searches = 0;
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async () => {
      searches++;
      return [];
    },
  };
  assert.equal(await adapter.explainEmptySelection(), null);
  assert.equal(searches, 0, "must not cost a query when there is nothing to attribute");
});

test("explainEmptySelection counts ready items without the label clause", async () => {
  const { adapter } = primed({}, gatedCfg({ requireLabels: ["crew"] }));
  const jqls: string[] = [];
  (adapter as unknown as { client: { search: unknown } }).client = {
    search: async (q: string) => {
      jqls.push(q);
      return [
        { id: "1", key: "BRI-1", fields: { summary: "a", status: { name: "Todo" }, labels: ["type:task"] } },
        { id: "2", key: "BRI-2", fields: { summary: "b", status: { name: "Todo" }, labels: ["type:task", "crew"] } },
      ];
    },
  };

  const r = await adapter.explainEmptySelection();
  // The diagnostic query must NOT carry the gate, or it could only ever report
  // passedGate === ready and would never detect a gate that filters everything.
  assert.ok(!jqls[0].includes("labels in"), jqls[0]);
  assert.equal(r?.ready, 2);
  assert.equal(r?.passedGate, 1);
});

// ------------------------------- setLabels ----------------------------------

/**
 * Jira has no add/remove label call — the whole array is replaced — so the
 * current labels must be read first. Dropping them would strip the type label
 * that makes an item executable at all.
 */

test("setLabels merges onto the issue's existing labels", async () => {
  const { adapter, calls } = primed({
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: { labels: ["type:task", "keep-me"] } },
  });
  await adapter.setLabels("BRI-1", { add: ["crew:stuck"] });

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { fields: { labels: ["type:task", "keep-me", "crew:stuck"] } });
});

test("setLabels removes only what was asked for", async () => {
  const { adapter, calls } = primed({
    "GET /issue/BRI-1": {
      id: "1",
      key: "BRI-1",
      fields: { labels: ["type:task", "crew:stuck"] },
    },
  });
  await adapter.setLabels("BRI-1", { add: ["crew:needs-human"], remove: ["crew:stuck"] });

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { fields: { labels: ["type:task", "crew:needs-human"] } });
});

test("setLabels does not write when nothing would change", async () => {
  const { adapter, calls } = primed({
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: { labels: ["type:task"] } },
  });
  // Adding a label it already has, removing one it doesn't.
  await adapter.setLabels("BRI-1", { add: ["type:task"], remove: ["crew:stuck"] });
  assert.equal(calls.some((c) => c.method === "PUT"), false, "no pointless API call");
});

test("setLabels is a no-op when both lists are empty", async () => {
  const { adapter, calls } = primed({});
  await adapter.setLabels("BRI-1", {});
  assert.deepEqual(calls, [], "must not even read the issue");
});

test("setLabels replaces spaces, which Jira rejects in a label", async () => {
  const { adapter, calls } = primed({
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: { labels: [] } },
  });
  await adapter.setLabels("BRI-1", { add: ["needs human"] });

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { fields: { labels: ["needs-human"] } });
});

test("setLabels tolerates an issue with no labels field", async () => {
  const { adapter, calls } = primed({
    "GET /issue/BRI-1": { id: "1", key: "BRI-1", fields: {} },
  });
  await adapter.setLabels("BRI-1", { add: ["crew:stuck"] });

  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { fields: { labels: ["crew:stuck"] } });
});
