/**
 * OAuth 2.0 (authorization code + PKCE) for MCP servers, sized for how crew
 * actually runs.
 *
 * crew's own runs are headless — cron-fired, no human, no browser — so there is
 * never a moment mid-run where a consent screen could be answered. The flow
 * that needs a browser happens exactly once, ahead of time, driven by a human
 * at a terminal: `crew mcp login <server>`. That produces a refresh token,
 * persisted to disk; every run after that (interactive or headless) just
 * exchanges the refresh token for a fresh access token, silently, no browser
 * involved. This mirrors how `gh auth login` / `gh auth status` split the two
 * concerns.
 *
 * PKCE (RFC 7636) is used unconditionally, even for confidential clients that
 * also send a `client_secret` — it costs nothing and closes the authorization-
 * code-interception hole on the loopback redirect.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { McpOAuthConfig } from "../types.js";

export class OAuthError extends Error {}

/** `~/.crew/oauth/<server>.json` — outside the repo, alongside `~/.crew/env`. */
function tokenDir(): string {
  return join(homedir(), ".crew", "oauth");
}

function tokenPath(server: string): string {
  return join(tokenDir(), `${server}.json`);
}

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent means "treat as expired" — always refresh first. */
  expiresAt?: number;
  scope?: string;
}

function loadToken(server: string): StoredToken | null {
  const path = tokenPath(server);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredToken;
  } catch {
    return null;
  }
}

function saveToken(server: string, token: StoredToken): void {
  mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  const path = tokenPath(server);
  // `mode` on writeFileSync only applies at file *creation* — if a token file
  // from a prior run (or a stray pre-existing file) is being overwritten, its
  // existing permissions carry over untouched. chmod after write closes that,
  // so a token holding a live bearer credential is never left world-readable.
  writeFileSync(path, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Removes the stored token for `server`. No-op if there isn't one. */
export function forgetToken(server: string): void {
  const path = tokenPath(server);
  if (existsSync(path)) rmSync(path);
}

export function hasStoredToken(server: string): boolean {
  return loadToken(server) !== null;
}

// ----------------------------- PKCE -----------------------------------------

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ----------------------------- token exchange --------------------------------

async function exchangeToken(
  cfg: McpOAuthConfig,
  body: Record<string, string>,
): Promise<StoredToken> {
  const params = new URLSearchParams({ client_id: cfg.clientId, ...body });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params,
  });
  if (!res.ok) {
    throw new OAuthError(`token request failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) throw new OAuthError("token response had no access_token");
  return {
    accessToken: json.access_token,
    // A provider that omits refresh_token on refresh means "same one still
    // valid" (RFC 6749 doesn't require re-issuing it) — keep the old one.
    refreshToken: json.refresh_token ?? body.refresh_token,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
    scope: json.scope,
  };
}

/** Open `url` in the user's default browser. Best-effort; prints it either way. */
function openBrowser(url: string): void {
  const bin =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(bin, [url], () => {
    // Ignored: the URL is always printed too, so a headless terminal or a
    // missing opener degrades to "copy this link" rather than failing.
  });
}

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Run the interactive authorization-code + PKCE flow for one server: start a
 * loopback listener, open the browser, wait for the redirect, exchange the
 * code, persist the resulting token. Call from `crew mcp login` only — this
 * is the one piece of OAuth support that needs a human and a browser.
 */
export async function loginInteractive(
  server: string,
  cfg: McpOAuthConfig,
  opts: { onUrl?: (url: string) => void; timeoutMs?: number } = {},
): Promise<void> {
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));

  const { redirectUri, waitForCode, close, port } = await startLoopbackListener(cfg.redirectUri);

  const authUrl = new URL(cfg.authorizationUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  if (cfg.scopes) authUrl.searchParams.set("scope", cfg.scopes);

  opts.onUrl?.(authUrl.toString());
  openBrowser(authUrl.toString());

  try {
    const code = await waitForCode(state, opts.timeoutMs ?? 5 * 60 * 1000);
    const token = await exchangeToken(cfg, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    saveToken(server, token);
  } finally {
    close();
    void port;
  }
}

/**
 * A localhost HTTP server for exactly one OAuth redirect, on an ephemeral port
 * unless `fixedRedirectUri` pins one (some providers require a pre-registered
 * exact redirect URI, port included).
 */
async function startLoopbackListener(fixedRedirectUri?: string): Promise<{
  redirectUri: string;
  waitForCode: (expectedState: string, timeoutMs: number) => Promise<string>;
  close: () => void;
  port: number;
}> {
  const fixedPort = fixedRedirectUri ? Number(new URL(fixedRedirectUri).port) || 80 : 0;

  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((err: Error) => void) | null = null;
  let expectedState = "";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");

    res.setHeader("Content-Type", "text/html");
    if (error) {
      res.end(`<p>Authorization failed: ${error}. You can close this tab.</p>`);
      rejectCode?.(new OAuthError(`provider returned error: ${error}`));
      return;
    }
    if (!code) {
      res.end("<p>No authorization code received. You can close this tab.</p>");
      return;
    }
    if (gotState !== expectedState) {
      res.end("<p>State mismatch — rejected for your safety. You can close this tab.</p>");
      rejectCode?.(new OAuthError("redirect state did not match — possible CSRF, aborting"));
      return;
    }
    res.end("<p>Authorized. You can close this tab and return to the terminal.</p>");
    resolveCode?.(code);
  });

  await new Promise<void>((resolve) => server.listen(fixedPort, LOOPBACK_HOST, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : fixedPort;
  const redirectUri = fixedRedirectUri ?? `http://${LOOPBACK_HOST}:${port}/callback`;

  return {
    redirectUri,
    port,
    close: () => server.close(),
    waitForCode: (expectedStateArg, timeoutMs) => {
      expectedState = expectedStateArg;
      return new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
        setTimeout(
          () => reject(new OAuthError("timed out waiting for the browser redirect")),
          timeoutMs,
        );
      });
    },
  };
}

// ----------------------------- headless refresh ------------------------------

/** Skip a refresh this close to expiry — same margin as clock-skew tolerance. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * The bearer token to use for `server` right now: the cached access token if
 * still fresh, or a freshly refreshed one. Never opens a browser — safe to
 * call from a headless run. Throws `OAuthError` if there is no stored token
 * (never logged in) or the refresh itself fails (revoked/expired refresh
 * token), both of which mean `crew mcp login <server>` needs to run again.
 */
export async function accessTokenFor(server: string, cfg: McpOAuthConfig): Promise<string> {
  const stored = loadToken(server);
  if (!stored) {
    throw new OAuthError(`no stored token for "${server}" — run: crew mcp login ${server}`);
  }
  const fresh = stored.expiresAt === undefined || stored.expiresAt - EXPIRY_SKEW_MS > Date.now();
  if (fresh) return stored.accessToken;

  if (!stored.refreshToken) {
    throw new OAuthError(
      `stored token for "${server}" expired and has no refresh token — run: crew mcp login ${server}`,
    );
  }
  try {
    const refreshed = await exchangeToken(cfg, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
    });
    saveToken(server, refreshed);
    return refreshed.accessToken;
  } catch (e) {
    throw new OAuthError(
      `refreshing the token for "${server}" failed (${(e as Error).message}) — run: crew mcp login ${server}`,
    );
  }
}
