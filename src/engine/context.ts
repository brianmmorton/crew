import type { AgentDef, CrewConfig, WorkItem } from "../types.js";

/** Assemble the full prompt for an executor agent working one issue. */
export function buildImplementerPrompt(
  cfg: CrewConfig,
  personaPrompt: string,
  constitution: string,
  item: WorkItem,
): string {
  const noTouch = cfg.gates.noTouch.map((g) => `  - ${g}`).join("\n");
  return `${personaPrompt}

# The task you are implementing

**${item.identifier}: ${item.title}**

${item.description || "(no description provided)"}

# Material-impact policy (read carefully)

If doing this task well would require changing anything on the list below, STOP:
do not implement it, make no commit, and end your run — it needs a PRD and human
approval first. Only proceed if the task is safe to execute as-is.

${constitution}

# Hard constraints

- You are in an isolated git worktree on a throwaway branch. Do NOT push or open a PR — the runner does that.
- Follow the repo's AGENTS.md for verification commands, conventions, and the pre-commit hook.
- Never modify these protected paths:
${noTouch}
- Make exactly ONE atomic commit (git add + git commit) with a Conventional-Commits subject, or make NO commit if you cannot complete the task cleanly and verifiably.
- Everything you change must pass the affected app's verify script before you commit.
`;
}

/**
 * Assemble the prompt for a proposer agent (QA / Design / Architect, or any
 * custom one). `agent.allowedTypes` and `agent.maxProposals` are stated in the
 * prompt AND enforced in code afterwards — the prompt is a courtesy, the
 * enforcement in `proposerCycle` is the guarantee.
 */
export function buildProposerPrompt(
  cfg: CrewConfig,
  personaPrompt: string,
  constitution: string,
  agent: AgentDef,
): string {
  const types = agent.allowedTypes?.length
    ? agent.allowedTypes.join(" | ")
    : "bug | task | chore-dx | prd | spike";
  const limits = [
    agent.allowedTypes?.length
      ? `You may ONLY file items of type: ${agent.allowedTypes.join(", ")}. Anything else is discarded.`
      : "",
    agent.maxProposals
      ? `File at most ${agent.maxProposals} proposal(s) — the best ones. Extras are discarded.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${personaPrompt}
${limits ? `\n# Your limits\n\n${limits}\n` : ""}

# Material-impact policy

Anything on this list is "material" — for those, set "isMaterial": true on the
proposal and phrase it as a PRD (a written spec in the body), because it requires
human approval before any code is written. Everything else is a normal task/bug
with "isMaterial": false.

${constitution}

# You are READ-ONLY

Do not modify, commit, or push anything. Your only output is the JSON below.

# Required output format

End your response with a single fenced JSON block and nothing after it:

\`\`\`json
{
  "summary": "one line on what you looked at",
  "proposals": [
    {
      "type": "${types}",
      "title": "short imperative title",
      "body": "markdown: the problem, evidence, and suggested approach (for a PRD, the full spec)",
      "severity": "low | medium | high | critical",
      "complexity": "low | medium | high",
      "evidence": "file paths, test names, or screenshots that show the issue",
      "isMaterial": false
    }
  ]
}
\`\`\`

Set "severity" by how much it matters (drives pickup priority) and "complexity"
by how hard the change is (low = a few lines / one file; high = multi-file,
tricky, or risky — drives which model implements it). Propose only things you are
confident are real and valuable. Zero proposals is a fine answer. Do not repeat
work that clearly already exists.
`;
}

/**
 * Assemble the prompt for a reviewer agent inspecting a just-opened PR. The
 * reviewer is read-only and performs no actions itself: it returns a verdict
 * and the engine applies the parts it is permitted to (see `canTransitionTo`).
 */
export function buildReviewerPrompt(
  cfg: CrewConfig,
  agent: AgentDef,
  constitution: string,
  item: WorkItem,
  prUrl: string,
): string {
  const allowed = agent.canTransitionTo ?? [];
  const transitionDoc = allowed.length
    ? `Set "transitionTo" to one of: ${allowed.join(", ")} — or omit it to leave\nthe issue where it is. Any other value is rejected by the engine.`
    : `You may NOT move this issue. Omit "transitionTo".`;

  return `${agent.prompt}

# What you are reviewing

**${item.identifier}: ${item.title}** — pull request: ${prUrl}

${item.description || "(no description provided)"}

You are in a git worktree containing the branch as it was pushed. Review the
diff against the base branch (\`git diff origin/${cfg.repo.baseBranch}...HEAD\`)
plus any context you need from the repo.

# Material-impact policy (for judging risk)

${constitution}

# You are READ-ONLY

Do not modify, commit, or push anything. Do not comment on the PR yourself and
do not touch Linear — the engine performs every action from your JSON below.

# Required output format

End your response with a single fenced JSON block and nothing after it:

\`\`\`json
{
  "verdict": "approve | comment | changes-requested",
  "prComment": "markdown posted as a comment on the pull request (omit for none)",
  "issueComment": "markdown posted on the Linear issue (omit for none)",
  "transitionTo": "workflow state name (see below)",
  "proposals": []
}
\`\`\`

${transitionDoc}

Use "proposals" to file follow-up work you don't want to block this PR on; it
takes the same shape a proposer uses (type/title/body/severity/isMaterial).
Keep comments specific and actionable — cite file:line. If the change looks
good, say so briefly rather than inventing objections.
`;
}

/** Short reflection prompt run after a successful PR, to capture DX friction. */
export function buildReflectionPrompt(): string {
  return `You just finished implementing a task in this repo. Reflect briefly:
what made the work harder than it should have been? Slow environment setup,
confusing modules, missing tests/fixtures, undocumented behavior, flaky checks?

Output ONLY a fenced JSON block with concrete developer-experience improvements
(or an empty array). Do not change any files.

\`\`\`json
{ "friction": [ { "type": "chore-dx", "title": "...", "body": "...", "severity": "low", "isMaterial": false } ] }
\`\`\`
`;
}

export function prBody(item: WorkItem): string {
  return `${item.description || ""}

---
Implements **${item.identifier}** — ${item.url}

_Opened automatically by \`crew\`. Verified against the affected app's checks before this PR was created; please review before merging._`;
}

export function tail(s: string, n = 3000): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}
