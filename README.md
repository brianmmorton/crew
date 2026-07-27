# crew

An autonomous agent team for any code repository. Role-specialized agents propose
typed work into [Linear](https://linear.app), anything **material** is gated
behind a human-approved PRD, and an executor drains approved work into pull
requests — running on your machine against your own coding-agent CLI.

crew is project- and provider-agnostic: the engine assumes no language or
toolchain, and it can drive Claude Code, Codex, Cursor, or any other agent CLI.
Each repo gets a small versioned `.crew/` folder describing how to run it.

## What it does

crew turns a Linear board into a work queue that a small team of agents moves
through, with you at two control points:

- **Proposers** (QA, Design, Architect) run on a schedule, read the repo
  read-only, and file typed issues — bugs, tasks, chores, or, for anything that
  materially affects the product, a **PRD** that waits for your approval.
- The **Implementer** picks up ready work, implements it in an isolated git
  worktree, and opens a **pull request** — it never commits to your main branch,
  and nothing merges without your review.
- A **self-review** step after each task files developer-experience friction as
  follow-up chores, and dedup keeps the backlog from ballooning.

Linear is the single source of truth; the agents are stateless workers and the
engine owns every state transition, so the flow is deterministic and auditable.

## How it works

Work items are Linear issues with a **type** (label), a **workflow state**, a
**priority** (drives pickup order), and a **complexity** (selects which model
implements it). The executor only works items in your *ready* state that carry a
task/bug/chore label and aren't blocked by an unapproved PRD. Two gates are
enforced in code, not convention: the PRD-approval block, and (optionally) a
project-defined verify command that must pass before a PR is opened.

## Requirements

- **Node.js 20+** (to run crew itself; your project can be any language).
- **git** and the **GitHub CLI** (`gh`, authenticated) for branch/PR operations.
- A **coding-agent CLI** — Claude Code (`claude`) by default, or another you
  configure.
- A **Linear** account and a personal API key.

Run `crew doctor` anytime to check these.

## Install

```bash
git clone <this-repo> crew && cd crew
npm install
npm run build
npm link          # puts `crew` on your PATH
```

## Quick start

```bash
cd ~/your-project
crew setup                       # an agent tailors .crew/ to this repo,
                                 # then sets up .env + .gitignore and checks prereqs
git add .crew && git commit -m "chore: add crew config"

# Put your secrets in .crew/.env (read automatically — no shell exports):
#   LINEAR_API_KEY           Linear → Settings → Security & access → API keys
#   CLAUDE_CODE_OAUTH_TOKEN  for the Claude provider: run `claude setup-token`

crew status                      # confirm it connects; shows the schedule
crew run                         # run the whole team (Ctrl-C to stop)
```

One-time in Linear: add a workflow status named **Needs Approval** (type
*unstarted*). Type labels (`type:task`, etc.) are created automatically.

## Commands

| Command | What it does |
|---|---|
| `crew setup` | Onboard a repo: an agent tailors the config, then sets up `.env`/`.gitignore` |
| `crew init` | Scaffold generic `.crew/` templates without the agent |
| `crew doctor` | Check required tools and secrets are present |
| `crew status` | Backlog / WIP counts, the proposer schedule, and log path |
| `crew once <persona>` | Run one cycle of `implementer`/`qa`/`design`/`architect` now |
| `crew run` | Run the whole team in one process (executor loop + scheduled proposers) |

While `crew run` is attached to a terminal it accepts single-key controls:
`q`/`d`/`a` run QA/Design/Architect now, `i` nudges the executor, `k` kills the
running agent, `p` pauses/resumes, `s` prints status, `Ctrl-C` quits.

## Configuration

Everything lives in `<repo>/.crew/` (versioned): `config.yaml`, `constitution.md`
(what counts as "material"), and `personas/*.md` (the agent prompts). Highlights
of `config.yaml`:

- **agent** — which CLI to drive. `provider: claude` is built-in; for any other
  CLI set `provider` plus a `command`, `args`, `promptVia`, and optional
  `modelFlag`.
- **models** — map work-item complexity (`low`/`medium`/`high`) to a model, so
  cheap tasks use a cheap model and hard ones your strongest. For Claude, use
  aliases (`haiku`/`sonnet`/`opus`).
- **gates** — `verify` (per-app commands; empty = trust the agent + PR review),
  `setup` (an env-prep command run before verify), `noTouch` (paths agents must
  never modify), and `wipCap`.
- **linear** — `team`, an optional `project` to scope this repo, workflow state
  names, and `autoPromote` (non-material proposals go straight to ready).
- **personas** — per-persona cron cadences.

The `.crew/` directory name can be overridden with the `CREW_DIR` env var.

## Providers

crew drives Claude Code out of the box with live step-by-step streaming and
subscription auth. To use a different agent CLI, point the `agent` config at it —
crew feeds it the prompt, streams its output, and treats the result as the
agent's work. The agent is responsible for setting up its own toolchain; crew
never assumes one.

## Safety

Every task runs in an isolated git worktree on a throwaway branch; the executor
never touches your main branch. A `noTouch` list protects secrets, migrations,
CI, and infra. Material changes stop for human approval as a PRD, verification
gates run before any PR, and nothing merges without your review. Logs stream to
`.crew/logs/` and each agent run is saved under `.crew/logs/runs/`.
