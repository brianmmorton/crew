import { proxy } from "valtio";

/**
 * MCP server status for the header. One row per server actually granted to
 * some agent (a server defined but never granted is nobody's business).
 * `loggedIn` is null for non-OAuth servers — they're configured or they
 * aren't; there's no login to check.
 */

export interface McpStatus {
  server: string;
  oauth: boolean;
  /** OAuth servers: token on disk? Non-OAuth: null. */
  loggedIn: boolean | null;
}

export const mcpStore = proxy({
  servers: [] as McpStatus[],
});

export function resetMcpStore(): void {
  mcpStore.servers = [];
}
