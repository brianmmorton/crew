import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BitbucketForge,
  parseBitbucketRemote,
  parsePrUrl,
} from "./bitbucket.js";

/**
 * Bitbucket has no CLI to lean on, so the adapter owns two pieces of parsing
 * that `gh` would otherwise do for us — the remote -> workspace/slug inference
 * and recovering a PR id from its URL. Both are pinned here, along with the
 * request bodies, since a wrong body fails only against the live API.
 */

test("parseBitbucketRemote handles the SSH, HTTPS and ssh:// spellings", () => {
  const want = "acme/widgets";
  assert.equal(parseBitbucketRemote("git@bitbucket.org:acme/widgets.git"), want);
  assert.equal(parseBitbucketRemote("git@bitbucket.org:acme/widgets"), want);
  assert.equal(
    parseBitbucketRemote("https://user@bitbucket.org/acme/widgets.git"),
    want,
  );
  assert.equal(parseBitbucketRemote("https://bitbucket.org/acme/widgets"), want);
  assert.equal(
    parseBitbucketRemote("ssh://git@bitbucket.org/acme/widgets.git"),
    want,
  );
  // Trailing slash shouldn't produce an empty second segment.
  assert.equal(parseBitbucketRemote("https://bitbucket.org/acme/widgets/"), want);
});

test("parseBitbucketRemote rejects non-Bitbucket and incomplete remotes", () => {
  assert.equal(parseBitbucketRemote("git@github.com:acme/widgets.git"), null);
  assert.equal(parseBitbucketRemote("https://bitbucket.org/acme"), null);
  assert.equal(parseBitbucketRemote(""), null);
});

test("parsePrUrl recovers workspace, repo and id", () => {
  assert.deepEqual(
    parsePrUrl("https://bitbucket.org/acme/widgets/pull-requests/42"),
    { repo: "acme/widgets", id: "42" },
  );
  // Bitbucket appends a slug/tab to the URL it shows in the browser.
  assert.deepEqual(
    parsePrUrl("https://bitbucket.org/acme/widgets/pull-requests/42/some-title/diff"),
    { repo: "acme/widgets", id: "42" },
  );
  assert.equal(parsePrUrl("https://github.com/acme/widgets/pull/42"), null);
});

/** Capture what the adapter would send, without touching the network. */
function recorder(response: unknown, status = 200) {
  const calls: { url: string; method: string; body: unknown; auth: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method as string,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(response),
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("openPr posts source/destination branches and returns the html link", async () => {
  const { calls, fetchImpl } = recorder({
    id: 7,
    links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/7" } },
  });
  const forge = new BitbucketForge(
    { username: "u", appPassword: "p" },
    "acme/widgets",
    fetchImpl,
  );

  const url = await forge.openPr({
    repoPath: "/repo",
    branch: "agent/bri-1",
    baseBranch: "main",
    title: "Fix the thing",
    body: "why",
    assignee: "@me",
    label: "agent-authored",
  });

  assert.equal(url, "https://bitbucket.org/acme/widgets/pull-requests/7");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests",
  );
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    title: "Fix the thing",
    description: "why",
    source: { branch: { name: "agent/bri-1" } },
    destination: { branch: { name: "main" } },
    close_source_branch: true,
  });
  // Bitbucket has no labels or assignees on PRs — neither may leak into the body.
  assert.equal(JSON.stringify(calls[0].body).includes("agent-authored"), false);
  assert.equal(JSON.stringify(calls[0].body).includes("@me"), false);
});

test("openPr falls back to a rebuilt URL when links are absent", async () => {
  const { fetchImpl } = recorder({ id: 9 });
  const forge = new BitbucketForge({ accessToken: "t" }, "acme/widgets", fetchImpl);
  const url = await forge.openPr({
    repoPath: "/repo",
    branch: "b",
    baseBranch: "main",
    title: "t",
    body: "b",
    assignee: "@me",
  });
  assert.equal(url, "https://bitbucket.org/acme/widgets/pull-requests/9");
});

/** Open a throwaway PR just to capture the Authorization header. */
async function authHeaderFor(auth: ConstructorParameters<typeof BitbucketForge>[0]) {
  const { calls, fetchImpl } = recorder({ id: 1 });
  await new BitbucketForge(auth, "a/b", fetchImpl).openPr({
    repoPath: "/r", branch: "b", baseBranch: "main", title: "t", body: "d", assignee: "@me",
  });
  return calls[0].auth;
}

test("an access token authenticates as Bearer", async () => {
  assert.equal(await authHeaderFor({ accessToken: "t0k" }), "Bearer t0k");
});

test("an Atlassian API token authenticates as Basic with the account email", async () => {
  // The API token replaced app passwords when Atlassian removed them on
  // 2026-07-28. It is Basic auth like an app password, but keyed by EMAIL —
  // sending a username here is a silent 401, so this pins the pairing.
  assert.equal(
    await authHeaderFor({ email: "me@example.com", apiToken: "tok" }),
    `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`,
  );
});

test("a legacy app password still forms a Basic header, keyed by username", async () => {
  assert.equal(
    await authHeaderFor({ username: "u", appPassword: "p" }),
    `Basic ${Buffer.from("u:p").toString("base64")}`,
  );
});

test("an access token wins over the other credential shapes", async () => {
  assert.equal(
    await authHeaderFor({
      accessToken: "t0k",
      email: "me@example.com",
      apiToken: "tok",
      username: "u",
      appPassword: "p",
    }),
    "Bearer t0k",
  );
});

test("an API token wins over a legacy app password", async () => {
  // Someone mid-migration may have both set; the working credential must win.
  assert.equal(
    await authHeaderFor({
      email: "me@example.com",
      apiToken: "tok",
      username: "u",
      appPassword: "p",
    }),
    `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`,
  );
});

test("commentOnPr targets the repo named in the URL, not the configured one", async () => {
  const { calls, fetchImpl } = recorder({});
  // Deliberately different from the URL below: the comment must follow the URL,
  // which is what the engine hands it.
  const forge = new BitbucketForge({ accessToken: "t" }, "other/repo", fetchImpl);
  await forge.commentOnPr(
    "https://bitbucket.org/acme/widgets/pull-requests/42",
    "looks good",
  );
  assert.equal(
    calls[0].url,
    "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/42/comments",
  );
  assert.deepEqual(calls[0].body, { content: { raw: "looks good" } });
});

test("commentOnPr rejects a URL that isn't a Bitbucket PR", async () => {
  const { fetchImpl } = recorder({});
  const forge = new BitbucketForge({ accessToken: "t" }, "a/b", fetchImpl);
  await assert.rejects(
    () => forge.commentOnPr("https://github.com/a/b/pull/1", "hi"),
    /Not a Bitbucket pull request URL/,
  );
});

test("an API error surfaces Bitbucket's message, not a bare status", async () => {
  const { fetchImpl } = recorder(
    { error: { message: "Branch 'nope' not found" } },
    400,
  );
  const forge = new BitbucketForge({ accessToken: "t" }, "a/b", fetchImpl);
  await assert.rejects(
    () =>
      forge.openPr({
        repoPath: "/r", branch: "nope", baseBranch: "main",
        title: "t", body: "d", assignee: "@me",
      }),
    /Branch 'nope' not found/,
  );
});
