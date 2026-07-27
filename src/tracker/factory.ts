/**
 * Provider selection: build the one `TrackerPort` this project uses.
 *
 * This is the only place that knows which trackers exist. Everything upstream
 * of it — the engine, the cycles, the CLI — sees a `TrackerPort` and nothing
 * more, which is what lets a second tracker be added without touching them.
 */

import type { CrewConfig, TrackerPort } from "../types.js";
import { LinearAdapter } from "./linear/adapter.js";
import { JiraAdapter } from "./jira/adapter.js";

export class TrackerAuthError extends Error {}

/** Env vars each provider needs, for `crew doctor` and the error below. */
export const REQUIRED_ENV: Record<CrewConfig["tracker"]["provider"], string[]> = {
  linear: ["LINEAR_API_KEY"],
  jira: ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
};

/**
 * Construct the configured tracker adapter. Throws `TrackerAuthError` naming
 * the exact missing variables — the most common first-run failure, so it's
 * worth a precise message rather than a generic auth error from the API.
 */
export function createTracker(cfg: CrewConfig): TrackerPort {
  const provider = cfg.tracker.provider;
  const missing = REQUIRED_ENV[provider].filter((v) => !process.env[v]?.trim());
  if (missing.length) {
    const them = missing.length > 1 ? "them" : "it";
    throw new TrackerAuthError(
      `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set for tracker ` +
        `provider "${provider}". Put ${them} in ${cfg.configDir}/.env or ~/.crew/env, ` +
        `or export ${them} in your shell. Run \`crew doctor\` to see everything ` +
        `your configured providers need.`,
    );
  }

  switch (provider) {
    case "linear":
      return new LinearAdapter(process.env.LINEAR_API_KEY as string, cfg);
    case "jira":
      return new JiraAdapter(
        {
          host: process.env.JIRA_HOST as string,
          email: process.env.JIRA_EMAIL as string,
          apiToken: process.env.JIRA_API_TOKEN as string,
        },
        cfg,
      );
    default: {
      // Unreachable while the schema enum and this switch agree; kept so adding
      // a provider to the enum without an adapter fails to compile.
      const exhaustive: never = provider;
      throw new TrackerAuthError(`Unknown tracker provider: ${String(exhaustive)}`);
    }
  }
}
