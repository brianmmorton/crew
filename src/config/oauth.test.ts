import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpOAuthConfig } from "../types.js";

const CFG: McpOAuthConfig = {
  authorizationUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  clientId: "client-abc",
};

let fakeHome: string;
let realHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "crew-oauth-test-"));
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  mock.reset();
});

afterEach(() => {
  process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  mock.restoreAll();
});

// Imported after HOME is patched per-test would be ideal, but the module only
// reads homedir() inside function bodies (not at import time), so a single
// static import is safe as long as every test patches HOME in beforeEach.
const { accessTokenFor, forgetToken, hasStoredToken, OAuthError } = await import("./oauth.js");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }) as Response & { ok: boolean };
}

// ----------------------------- token store -----------------------------------

test("hasStoredToken is false before any login", () => {
  assert.equal(hasStoredToken("server-a"), false);
});

test("forgetToken is a safe no-op when nothing is stored", () => {
  assert.doesNotThrow(() => forgetToken("never-logged-in"));
});

// ----------------------------- accessTokenFor ---------------------------------

test("accessTokenFor throws when no token has ever been stored", async () => {
  await assert.rejects(() => accessTokenFor("server-a", CFG), OAuthError);
});

test("accessTokenFor refreshes an expired token and persists the result", async () => {
  const dir = join(fakeHome, ".crew", "oauth");
  const path = join(dir, "server-c.json");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ accessToken: "stale", refreshToken: "refresh-xyz", expiresAt: Date.now() - 1000 }),
    "utf8",
  );

  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(init.body as string);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-xyz");
    assert.equal(body.get("client_id"), "client-abc");
    return jsonResponse({ access_token: "fresh-token", expires_in: 3600 });
  });

  const token = await accessTokenFor("server-c", CFG);
  assert.equal(token, "fresh-token");

  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.accessToken, "fresh-token");
  // Provider omitted refresh_token on refresh — RFC 6749 allows this to mean
  // "the old one is still valid", so it must be carried forward, not dropped.
  assert.equal(stored.refreshToken, "refresh-xyz");
});

test("accessTokenFor returns the cached token without a network call when not expired", async () => {
  const dir = join(fakeHome, ".crew", "oauth");
  const path = join(dir, "server-d.json");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ accessToken: "still-good", expiresAt: Date.now() + 60 * 60 * 1000 }),
    "utf8",
  );

  const fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("should not be called");
  });

  const token = await accessTokenFor("server-d", CFG);
  assert.equal(token, "still-good");
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("accessTokenFor throws when the stored token is expired with no refresh token", async () => {
  const dir = join(fakeHome, ".crew", "oauth");
  const path = join(dir, "server-e.json");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ accessToken: "old", expiresAt: Date.now() - 1000 }), "utf8");

  await assert.rejects(() => accessTokenFor("server-e", CFG), (e: Error) => {
    assert.match(e.message, /no refresh token/);
    return true;
  });
});

test("accessTokenFor surfaces a failed refresh as OAuthError rather than throwing raw", async () => {
  const dir = join(fakeHome, ".crew", "oauth");
  const path = join(dir, "server-f.json");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ accessToken: "old", refreshToken: "bad", expiresAt: Date.now() - 1000 }),
    "utf8",
  );

  mock.method(globalThis, "fetch", async () => jsonResponse({ error: "invalid_grant" }, false, 400));

  await assert.rejects(() => accessTokenFor("server-f", CFG), OAuthError);
});

test("stored token file is written with owner-only permissions", async () => {
  const dir = join(fakeHome, ".crew", "oauth");
  const path = join(dir, "server-g.json");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({ accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 1000 }),
    "utf8",
  );
  mock.method(globalThis, "fetch", async () => jsonResponse({ access_token: "x", expires_in: 10 }));
  await accessTokenFor("server-g", CFG);
  assert.equal(statSync(path).mode & 0o077, 0);
});

// ----------------------------- forgetToken ------------------------------------

test("forgetToken removes a stored token", async () => {
  const dir = join(fakeHome, ".crew", "oauth");
  const path = join(dir, "server-h.json");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ accessToken: "x" }), "utf8");

  assert.equal(hasStoredToken("server-h"), true);
  forgetToken("server-h");
  assert.equal(hasStoredToken("server-h"), false);
  assert.equal(existsSync(path), false);
});
