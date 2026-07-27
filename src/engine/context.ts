import type { CrewConfig, WorkItem, PersonaName } from "../types.js";

/** Assemble the full prompt for the Implementer working one issue. */
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

/** Assemble the prompt for a proposer persona (QA / Design / Architect). */
export function buildProposerPrompt(
  cfg: CrewConfig,
  personaPrompt: string,
  constitution: string,
  _name: PersonaName,
): string {
  return `${personaPrompt}

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
      "type": "bug | task | chore-dx | prd | spike",
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
