/**
 * The provider choices `crew setup` asks about, and how they are applied to a
 * freshly scaffolded config.yaml.
 *
 * Kept separate from the interactive prompting in onboard.ts so the mapping
 * from an answer to a config edit is a pure function and can be tested.
 */

import type { ForgeProvider } from "../types.js";

export type TrackerProvider = "linear" | "jira";

/** A coding-agent CLI crew knows how to drive out of the box. */
export interface AgentPreset {
  /** Value written to `agent.provider`. */
  provider: string;
  label: string;
  /** Binary on PATH; omitted for the built-in claude adapter. */
  command?: string;
  args?: string[];
  promptVia?: "stdin" | "arg";
  modelFlag?: string;
}

/**
 * The presets offered at setup. "other" is the escape hatch — it writes a
 * commented skeleton the user fills in, rather than guessing a CLI's flags.
 */
export const AGENT_PRESETS: AgentPreset[] = [
  {
    provider: "claude",
    label: "Claude Code (built-in: live streaming, subscription auth)",
  },
  {
    provider: "codex",
    label: "OpenAI Codex CLI",
    command: "codex",
    args: ["exec"],
    promptVia: "stdin",
    modelFlag: "--model",
  },
  {
    provider: "cursor",
    label: "Cursor CLI",
    command: "cursor-agent",
    args: ["-p"],
    promptVia: "stdin",
    modelFlag: "--model",
  },
  {
    provider: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    args: [],
    promptVia: "stdin",
    modelFlag: "--model",
  },
  {
    provider: "other",
    label: "Something else (fill in the command yourself)",
    command: "",
    args: [],
    promptVia: "stdin",
  },
];

export interface SetupChoices {
  tracker: TrackerProvider;
  forge: ForgeProvider;
  agent: AgentPreset;
  /** Bitbucket only, and only when the user typed one. */
  bitbucketRepo?: string;
  /**
   * Default branch detected from `origin/HEAD`. Written into config.yaml so the
   * file states the real branch rather than the template's `main` guess.
   */
  baseBranch?: string;
}

/** Env var names the chosen providers require, for the setup summary. */
export function requiredEnvFor(choices: SetupChoices): string[] {
  const env: string[] = [];
  env.push(
    ...(choices.tracker === "jira"
      ? ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"]
      : ["LINEAR_API_KEY"]),
  );
  // The access token is the recommended shape; app passwords were removed by
  // Atlassian on 2026-07-28 and are deliberately not suggested to new users.
  if (choices.forge === "bitbucket") env.push("BITBUCKET_ACCESS_TOKEN");
  if (choices.agent.provider === "claude") env.push("CLAUDE_CODE_OAUTH_TOKEN");
  return env;
}

/**
 * Rewrite the scaffolded config.yaml to match the chosen providers.
 *
 * This edits the template text rather than re-serializing parsed YAML, because
 * the template's comments are most of its value to someone editing it later —
 * a round-trip through a YAML dump would strip every one of them.
 */
export function applyChoices(yaml: string, choices: SetupChoices): string {
  let out = yaml;

  // tracker.provider — the first `provider:` under the `tracker:` block.
  out = out.replace(
    /^(tracker:\s*\n(?:[^\S\n]*(?:#[^\n]*)?\n)*[^\S\n]+provider:\s*)"[^"]*"/m,
    `$1"${choices.tracker}"`,
  );

  // agent.provider plus, for external CLIs, the command block underneath it.
  const agentBlock =
    choices.agent.provider === "claude"
      ? `agent:\n  provider: "claude"\n`
      : `agent:\n` +
        `  provider: "${choices.agent.provider}"\n` +
        `  command: "${choices.agent.command ?? ""}"` +
        `${choices.agent.command ? "" : "   # <-- the CLI binary on your PATH"}\n` +
        `  args: [${(choices.agent.args ?? []).map((a) => `"${a}"`).join(", ")}]\n` +
        `  promptVia: "${choices.agent.promptVia ?? "stdin"}"\n` +
        (choices.agent.modelFlag ? `  modelFlag: "${choices.agent.modelFlag}"\n` : "");
  out = out.replace(/^agent:\s*\n(?:[^\S\n]+[^\n]*\n)*/m, agentBlock);

  // repo.baseBranch — the template ships `main`; replace it with whatever
  // origin/HEAD actually points at, so the file is accurate on a repo whose
  // default branch is master/trunk/develop.
  if (choices.baseBranch) {
    out = out.replace(
      /^([^\S\n]+baseBranch:[^\S\n]*)("?)[^"\n]*\2[^\S\n]*$/m,
      `$1${choices.baseBranch}`,
    );
  }

  // repo.forge — rewrite the template's existing line rather than adding a
  // second one, which would make the file a duplicate-key YAML error.
  if (/^[^\S\n]+forge:/m.test(out)) {
    out = out.replace(/^([^\S\n]+forge:\s*)"[^"]*"/m, `$1"${choices.forge}"`);
  } else {
    out = out.replace(
      /^(repo:\s*\n(?:[^\S\n]+[^\n]*\n|[^\S\n]*\n)*)/m,
      (_m, block: string) => `${block}  forge: "${choices.forge}"\n`,
    );
  }

  // repo.bitbucketRepo — only meaningful on Bitbucket, and only when known.
  // The template ships it commented out; uncomment it in place when we have a
  // value, and otherwise leave the comment for the user to fill in.
  if (choices.forge === "bitbucket" && choices.bitbucketRepo) {
    const line = `  bitbucketRepo: "${choices.bitbucketRepo}"`;
    out = /^[^\S\n]*#?[^\S\n]*bitbucketRepo:/m.test(out)
      ? out.replace(/^[^\S\n]*#?[^\S\n]*bitbucketRepo:[^\n]*/m, line)
      : out.replace(/^([^\S\n]+forge:[^\n]*\n)/m, `$1${line}\n`);
  }

  return out;
}
