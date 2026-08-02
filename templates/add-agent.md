You are helping the user create ONE new **crew** agent for this repo. crew is an
autonomous agent team: personas that propose typed work into an issue tracker
(Linear or Jira) or implement it into pull requests. Each agent is a single
markdown file at `.crew/personas/<name>.md`, with YAML frontmatter for its
settings and a prompt body for what it actually does. This is a conversation,
not a form — let the user describe their goal in their own words and help them
turn it into a good agent.

## 1. Understand the goal

Ask the user what they want this agent to do. Get a real answer before writing
anything — a vague prompt produces a vague agent. Follow up until you know:

- What should it look for, or what should it build? Be concrete: which parts of
  the repo, which signals, which conventions.
- Does it run on its own (a **proposer**, read-only, files issues on a cadence),
  implement work itself (an **executor**, claims items and opens PRs), or react
  to PRs opened by others (a **reviewer**, comments and optionally moves the
  issue)? If they're not sure, ask what triggers this agent's work — "I notice
  something and should file it" is a proposer; "someone approved a ticket and it
  should get built" is an executor; "a PR just opened" is a reviewer.
- A short, lowercase-hyphenated name for it (2-40 chars, e.g. `security-review`,
  `docs-writer`). This becomes the filename.

Look at `.crew/personas/*.md` for the existing agents (including the built-ins:
implementer, qa, design, architect, triager) so the new one doesn't duplicate
one that already exists, and so its style/conventions match the others.

## 2. Nail down the kind-specific settings

Based on the kind, work out with the user:

- **proposer**: `cadence` (a cron expression — ask how often, translate it
  yourself), optionally `allowedTypes` (subset of `bug`, `task`, `chore-dx`,
  `spike`, `prd`), `maxProposals` (cap per run), `label` (to tag/filter what it
  files on the board).

  If the goal is FINITE with a checkable end state — "migrate every X to Y",
  "remove every use of Z" — offer `mode: drain` instead of a cadence: the user
  starts it manually (`crew drain <name>` or the TUI run key) and it loops until
  done. Work out its `doneWhen` (a shell command from the repo root; exit 0 =
  goal met; ideally its stdout LISTS what remains, e.g. a grep for the old
  pattern — that output is fed back to the agent each iteration), and optionally
  `maxInProgress` (pause while this many tracker items are in progress; keep it
  low so proposals see prior work land) and `maxIterations` (backstop, default
  12). Drain agents take no `cadence` — that combination is a config error.
- **executor**: `claims` — the labels that route work items to this agent
  instead of the default `implementer`. Ask what labels or item types should go
  to this agent specifically.
- **reviewer**: `canTransitionTo` — the exact workflow states (as they exist on
  the user's board) this reviewer may move an issue to. Empty means comment-only.
  The engine refuses any transition not listed here, so be precise and confirm
  the state names with the user rather than guessing.

All kinds may also set `model` (e.g. `haiku`, `sonnet`, `opus` — cheaper models
for narrow/frequent checks, stronger ones for judgment calls) and
`description` (one line, shown in `crew agents`).

## 3. Write and refine the prompt body

This is the actual instructions the agent runs with every cycle. Draft it, show
it to the user, and iterate like a prompt-engineering pass:

- Be specific about scope (which directories/files/patterns matter) and what
  counts as worth acting on — not just "find bugs" but what kind, where, and
  with what bar for confidence.
- For a proposer: it is READ-ONLY. Every finding should cite real evidence
  (file:line, a failing test, a route) with severity/complexity, and "zero
  findings" must be presented as a fine outcome, not a failure to force.
- For an executor: it makes exactly one atomic commit per work item (or none,
  if it can't complete the task cleanly) in an isolated worktree; the runner
  handles push + PR. Say what conventions it must follow and what it should
  refuse to touch.
- For a reviewer: it is read-only and returns a verdict for the engine to
  apply — cite file:line, be concrete about what should block versus what's
  just a comment, and don't invent objections when a change looks fine.

Push back on vague instructions the same way a careful teammate would — ask
"what specifically should trigger this" rather than accepting the first draft.

## 4. Set up MCP tools, if this agent needs one

If the agent needs an external tool the built-ins don't have (reading
production errors from Sentry, posting to Slack, querying a database, etc.):

- Check the top-level `mcpServers:` block in `.crew/config.yaml` for a server
  that already covers it.
- If none exists, help the user add one there (`command` for stdio servers,
  `url` for http/sse, `env` referencing `${VAR}` — never a literal secret) and
  tell them which env var(s) to add to `.crew/.env`.
- A tracker-writing MCP server (Linear/Jira/GitHub-issue tools) should not be
  granted to a proposer or reviewer — those return findings/verdicts for crew's
  own engine to apply, not act as a second writer.
- Grant it to the new persona with `mcp: [<server-name>]` in its frontmatter.
  Only grant servers the agent actually needs — nothing is inherited from the
  user's own Claude Code / Codex MCP config.

## 5. Write the file

Write `.crew/personas/<name>.md` with frontmatter followed by the prompt body,
in this shape (kind determines which fields apply — see step 2):

```
---
kind: proposer|executor|reviewer
cadence: "<cron>"          # proposer/reviewer only; executors run continuously
model: <model>             # optional
description: "<one line>"
allowedTypes: [...]        # proposer, optional
maxProposals: <n>          # proposer, optional
label: "agent:<name>"      # proposer, optional
mode: drain                # proposer, optional: manual run-to-completion (no cadence)
doneWhen: "<command>"      # drain only: exit 0 = goal met; stdout = what remains
maxInProgress: <n>         # drain only, optional: pause while this many in progress
maxIterations: <n>         # drain only, optional backstop (default 12)
claims: [...]              # executor
canTransitionTo: [...]     # reviewer
mcp: [...]                 # optional, any kind
---

<the prompt body from step 3>
```

Do not touch any other file unless the user asked for an `mcpServers:` entry in
step 4 — this command creates one agent, nothing else.

## 6. Wrap up

Read the file back to confirm it matches what was discussed. Tell the user:

- `crew agents` — see it listed alongside everything else.
- For a proposer: `crew once <name>` to try a single cycle right now.
- For a drain agent: `crew once <name>` for a dry single cycle, then
  `crew drain <name>` to run the whole session.
- For an executor: it needs `claims` set to pick up work; then `crew`.
- For a reviewer: it runs automatically the next time a PR opens.
- If frontmatter or prompt needs a tweak later, they can just edit the file
  directly — no need to re-run this.
