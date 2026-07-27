import type { ForgePort, OpenPrOptions } from "../../types.js";

/**
 * Bitbucket Cloud, over the REST v2 API.
 *
 * Unlike GitHub there is no first-party CLI to lean on, so this talks to the
 * API directly. Two things differ from `gh` and shape the code below:
 *
 * 1. Every call needs the `workspace/repo-slug`, which `gh` infers from the
 *    remote. We infer it the same way (see `parseBitbucketRemote`) unless the
 *    config names it explicitly.
 * 2. Bitbucket PRs have no labels and no assignee — only a single "reviewers"
 *    list of account UUIDs. Both `label` and `assignee` are therefore dropped
 *    rather than mapped onto something that doesn't mean the same thing.
 */

/**
 * Bitbucket accepts three credential shapes. In preference order:
 *
 * 1. `accessToken` — a repository/project/workspace access token, sent as a
 *    Bearer token. Not tied to a user account, so it's the best fit for a bot.
 * 2. `email` + `apiToken` — an Atlassian API token with scopes. This is the
 *    replacement Atlassian points app-password users at.
 * 3. `username` + `appPassword` — app passwords, which Atlassian removed on
 *    2026-07-28. Kept only so an existing config fails with a clear message
 *    rather than an opaque 401.
 *
 * Note that 2 and 3 are both HTTP Basic but differ in what goes in the
 * username field: an account *email* for an API token, a *username* for an app
 * password. Swapping them is a silent 401, which is why they are distinct
 * fields here rather than one reused pair.
 */
export interface BitbucketAuth {
  /** Access token (repository, project, or workspace scope). Preferred. */
  accessToken?: string;
  /** Atlassian API token with scopes, paired with the account email. */
  email?: string;
  apiToken?: string;
  /** Legacy app password flow — removed by Atlassian on 2026-07-28. */
  username?: string;
  appPassword?: string;
}

const API = "https://api.bitbucket.org/2.0";

/**
 * Pull `workspace/repo-slug` out of an origin URL. Handles the SSH, HTTPS and
 * (legacy) `ssh://` spellings Bitbucket hands out, with or without `.git`.
 */
export function parseBitbucketRemote(remote: string): string | null {
  const url = remote.trim();
  if (!url) return null;
  // git@bitbucket.org:workspace/repo.git
  const scp = /^[^@]+@bitbucket\.org:(.+)$/.exec(url);
  // https://user@bitbucket.org/workspace/repo.git | ssh://git@bitbucket.org/workspace/repo.git
  const proto = /^(?:https?|ssh):\/\/[^/]*bitbucket\.org\/(.+)$/.exec(url);
  const path = scp?.[1] ?? proto?.[1];
  if (!path) return null;
  const slug = path.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  // Guard against a remote that has extra path segments (or too few).
  const parts = slug.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
}

/**
 * Recover `workspace/repo/id` from a PR URL so reviewer comments can be posted
 * with only the URL in hand (the shape `commentOnPr` is given).
 */
export function parsePrUrl(
  prUrl: string,
): { repo: string; id: string } | null {
  const m =
    /bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(prUrl);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, id: m[3] };
}

export class BitbucketForge implements ForgePort {
  constructor(
    private readonly auth: BitbucketAuth,
    /** `workspace/repo-slug`, already resolved by the caller. */
    private readonly repoSlug: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private authHeader(): string {
    if (this.auth.accessToken) return `Bearer ${this.auth.accessToken}`;
    // Basic auth for both remaining shapes; only the username half differs.
    const [user, secret] =
      this.auth.apiToken !== undefined
        ? [this.auth.email ?? "", this.auth.apiToken]
        : [this.auth.username ?? "", this.auth.appPassword ?? ""];
    return `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
  }

  private async api(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: init.method,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    if (!res.ok) {
      // Bitbucket returns {error:{message}} on failure; fall back to raw text
      // so an HTML error page or a proxy response is still legible.
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } };
        if (j.error?.message) detail = j.error.message;
      } catch {
        /* not JSON — keep the raw body */
      }
      throw new Error(
        `Bitbucket ${init.method} ${path} failed (${res.status}): ${detail}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }

  async openPr(opts: OpenPrOptions): Promise<string> {
    // `assignee` and `label` have no Bitbucket equivalent (see the class note).
    const created = (await this.api(
      `/repositories/${this.repoSlug}/pullrequests`,
      {
        method: "POST",
        body: {
          title: opts.title,
          description: opts.body,
          source: { branch: { name: opts.branch } },
          destination: { branch: { name: opts.baseBranch } },
          close_source_branch: true,
        },
      },
    )) as {
      id?: number;
      links?: { html?: { href?: string } };
    };

    const href = created?.links?.html?.href;
    if (href) return href;
    // Older/proxied responses may omit links — rebuild the canonical URL.
    return created?.id
      ? `https://bitbucket.org/${this.repoSlug}/pull-requests/${created.id}`
      : "";
  }

  async commentOnPr(prUrl: string, body: string): Promise<void> {
    const target = parsePrUrl(prUrl);
    if (!target) {
      throw new Error(`Not a Bitbucket pull request URL: ${prUrl}`);
    }
    await this.api(
      `/repositories/${target.repo}/pullrequests/${target.id}/comments`,
      { method: "POST", body: { content: { raw: body } } },
    );
  }
}
