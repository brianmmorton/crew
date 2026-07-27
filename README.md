# crew

An autonomous agent team for any code repository. Role-specialized agents propose
typed work into [Linear](https://linear.app) or [Jira](https://www.atlassian.com/software/jira),
anything **material** is gated
behind a human-approved PRD, and an executor drains approved work into pull
requests — running on your machine against your own coding-agent CLI.

crew is project- and provider-agnostic: the engine assumes no language or
toolchain, and it can drive Claude Code, Codex, Cursor, or any other agent CLI.
Each repo gets a small versioned `.crew/` folder describing how to run it.

## What it does

crew turns your issue tracker's board into a work queue that a small team of
agents moves through, with you at two control points:

- **Proposers** (QA, Design, Architect) run on a schedule, read the repo
  read-only, and file typed issues — bugs, tasks, chores, or, for anything that
  materially affects the product, a **PRD** that waits for your approval.
- The **Implementer** picks up ready work, implements it in an isolated git
  worktree, and opens a **pull request** — it never commits to your main branch,
  and nothing merges without your review.
- A **self-review** step after each task files developer-experience friction as
  follow-up chores, and dedup keeps the backlog from ballooning.

The tracker is the single source of truth; the agents are stateless workers and
the engine owns every state transition, so the flow is deterministic and
auditable.

## How it works

Work items are tracker issues with a **type** (label), a **workflow state**, a
**priority** (drives pickup order), and a **complexity** (selects which model
implements it). The executor only works items in your *ready* state that carry a
task/bug/chore label and aren't blocked by an unapproved PRD. Two gates are
enforced in code, not convention: the PRD-approval block, and (optionally) a
project-defined verify command that must pass before a PR is opened.

## Requirements

- **Node.js 20+** (to run crew itself; your project can be any language).
- **git**, plus credentials for your code host: the **GitHub CLI** (`gh`,
  authenticated) for GitHub, or a **Bitbucket** app password / access token.
- A **coding-agent CLI** — Claude Code (`claude`) by default, or another you
  configure.
- A **Linear** or **Jira Cloud** account, and an API token for it.

`crew setup` asks which of these you use and writes the answers into your
config. Run `crew doctor` anytime to check the ones you chose.

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
crew setup                       # asks which tracker, code host and agent CLI
                                 # you use, then an agent tailors .crew/ to this
                                 # repo and sets up .env + .gitignore
git add .crew && git commit -m "chore: add crew config"

# Put your secrets in .crew/.env (read automatically — no shell exports).
# Only the ones matching your choices are needed; `crew doctor` lists them.
# Tracker — Linear:
#   LINEAR_API_KEY           Linear → Settings → Security & access → API keys
# Tracker — Jira Cloud:
#   JIRA_HOST                your-site.atlassian.net
#   JIRA_EMAIL               the account the token belongs to
#   JIRA_API_TOKEN           id.atlassian.com → Security → API tokens
# Code host — GitHub: nothing here; run `gh auth login`
# Code host — Bitbucket Cloud:
#   BITBUCKET_ACCESS_TOKEN   or the username/password pair below
#   BITBUCKET_USERNAME       your username (not your email)
#   BITBUCKET_APP_PASSWORD   Personal settings → App passwords ("Pull requests: Write")
# Agent:
#   CLAUDE_CODE_OAUTH_TOKEN  for the Claude provider: run `claude setup-token`
#                            (other CLIs use their own auth)

crew status                      # confirm it connects; shows the schedule
crew run                         # run the whole team (Ctrl-C to stop)
```

One-time on your board: add a workflow status named **Needs Approval** (in
Linear, of type *unstarted*). Type labels (`type:task`, etc.) are created
automatically.

### Using Jira

Set the provider and point `team` at your project **key** (not its name):

```yaml
tracker:
  provider: jira
  team: "BRI"                # Jira project key
  # project: "web"           # optional: a component, to scope one repo
  statuses:                  # must match your workflow's real status names
    backlog: "Backlog"
    ready: "To Do"
    inProgress: "In Progress"
    review: "In Review"
    needsApproval: "Needs Approval"
    done: "Done"
  jira:
    issueTypes:              # must exist in the project
      prd: "Task"
      bug: "Bug"
      task: "Task"
      chore: "Task"
```

crew validates the statuses and issue types at startup and tells you what the
project actually offers if one doesn't match. Two Jira details worth knowing:
status changes go through workflow **transitions**, so a status is only reachable
if your workflow has a path to it from where the issue sits; and descriptions are
converted to Atlassian Document Format, so markdown renders as plain text.

If your config still uses the older `linear:` block, it keeps working as-is —
it's read as `tracker:` with `provider: linear`.

### Using Bitbucket

The tracker and the code host are chosen independently — Bitbucket pairs with
either Linear or Jira. Set the forge under `repo:`:

```yaml
repo:
  path: "."
  baseBranch: main
  forge: "bitbucket"
  # bitbucketRepo: "my-workspace/my-repo"   # omit to infer from the origin remote
```

Then put credentials in `.crew/.env` — either an access token (workspace,
project, or repository scope):

```bash
BITBUCKET_ACCESS_TOKEN=...
```

...or a username + app password with the **Pull requests: Write** scope, from
*Personal settings → App passwords*:

```bash
BITBUCKET_USERNAME=your-username     # your username, not your email
BITBUCKET_APP_PASSWORD=...
```

crew talks to the Bitbucket Cloud REST API directly, so there's no CLI to
install. Two differences from GitHub are worth knowing: Bitbucket pull requests
have no labels and no assignee, so the `agent-authored` label and the assignment
crew applies on GitHub are simply skipped; and PRs are opened with
*close source branch* set, so merged agent branches clean themselves up.

## Commands

| Command | What it does |
|---|---|
| `crew setup` | Onboard a repo: an agent tailors the config, then sets up `.env`/`.gitignore` |
| `crew init` | Scaffold generic `.crew/` templates without the agent |
| `crew doctor` | Check required tools and secrets are present |
| `crew status` | Backlog / WIP counts, the agent schedule, and log path |
| `crew agents` | List every agent, its kind, cadence, and options |
| `crew agent new <name>` | Scaffold a new agent (`--kind proposer\|executor\|reviewer`) |
| `crew once <agent>` | Run one cycle of any agent now |
| `crew run` | Run the whole team in one process (executor loop + scheduled agents) |

While `crew run` is attached to a terminal it accepts single-key controls. Each
scheduled agent gets a key (its first free letter — `q` QA, `d` Design, `a`
Architect, and so on for your own), plus `i` nudges the executor, `k` kills the
running agent, `p` pauses/resumes, `s` prints status, `Ctrl-C` quits. The exact
legend is printed at startup.

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
- **tracker** — `provider` (`linear` or `jira`), `team` (a Linear team name or a
  Jira project key), an optional `project` to scope this repo (a Linear project
  or a Jira component), workflow state names, `autoPromote` (non-material
  proposals go straight to ready), and a `jira` block for Jira-specific issue
  types and priorities. The older `linear:` spelling is still accepted.
- **personas** — your agents; see below.

The `.crew/` directory name can be overridden with the `CREW_DIR` env var.

## Agents

The four agents crew ships with — Implementer, QA, Design, Architect — are not
special. Each is just a prompt at `.crew/personas/<name>.md`, and you can add
your own the same way. Every agent has a **kind** that decides how the engine
drives it:

| Kind | When it runs | What it does |
|---|---|---|
| `proposer` | on a cron cadence | Reads the repo read-only and files typed work items |
| `executor` | whenever there's ready work | Implements one item in a worktree and opens a PR |
| `reviewer` | after a PR is opened | Comments on the PR / tracker issue, can move the issue |

Create one with the scaffolder, then edit the prompt it writes:

```bash
crew agent new a11y --cadence "0 8 * * 1"     # a proposer (the default)
crew agent new docs-writer --kind executor
crew agent new security --kind reviewer --model opus
crew agents                                   # see them all
crew once a11y                                # try it right now
```

Or just drop a `.md` file into `.crew/personas/` — it's picked up automatically.

### Configuring an agent

Settings go in YAML frontmatter at the top of the persona file, or in the
`personas:` block of `config.yaml` (which wins where both set the same field —
handy for overriding a shared persona per project):

```markdown
---
kind: proposer
cadence: "0 8 * * 1"
model: haiku
allowedTypes: [bug]        # may only file bugs
maxProposals: 3            # at most 3 per run
label: "agent:a11y"        # tag its output so you can filter it on your board
---

You are the accessibility agent. Audit for…
```

| Option | Applies to | Meaning |
|---|---|---|
| `kind` | all | `proposer` (default), `executor`, or `reviewer` |
| `cadence` | proposers | Cron schedule; omit and it only runs via `crew once` |
| `model` | all | Model override for this agent |
| `description` | all | One-liner shown in `crew agents` |
| `allowedTypes` | proposers, reviewers | Item types it may file; others are discarded |
| `maxProposals` | proposers, reviewers | Cap on items filed per run |
| `label` | proposers, reviewers | Extra tracker label on everything it files |
| `claims` | executors | Item labels that route work to this agent |
| `canTransitionTo` | reviewers | Workflow states it may move an issue to |

`allowedTypes`, `maxProposals`, and `canTransitionTo` are enforced by the engine
after the agent runs, not just requested in the prompt — a custom agent can't
flood your backlog or move an issue somewhere you didn't allow.

### Custom executors

An executor claims work by label. Give it `claims: ["type:docs"]` and any ready
item carrying that label routes to it instead of the implementer; everything
unclaimed still goes to the implementer, so adding one never strands work. One
agent runs at a time under the existing `wipCap`.

### Reviewers

A reviewer runs against the branch right after its PR opens. Like every other
agent it performs no actions itself — it returns a verdict and the engine
applies it: a comment on the PR, a comment on the tracker issue, follow-up items,
and a state transition *if* the target is listed in `canTransitionTo` (empty
means comment-only). A reviewer that fails never blocks the PR.

Be deliberate about `canTransitionTo`. Listing your *ready* state (`Todo` by
default) means a rejected item becomes executable again and the executor will
rework it — useful, but if the reviewer keeps objecting the pair can loop and
burn usage. crew logs a loud warning each time this happens; watch for it, or
give the reviewer a state that parks the work instead (e.g. `Backlog`).

### Idle time

Proposers run on a cron cadence, but the executor drains work continuously — so
when the queue empties, the team can sit idle until the next tick. Instead of
waiting, crew pulls a proposer in early:

```yaml
idle:
  enabled: true
  afterMinutes: 10        # how long the queue stays empty before triggering
  minIntervalMinutes: 30  # floor on how often any one proposer runs
  maxBacklog: 0           # skip while the backlog is deeper than this
  maxEmptyRuns: 3         # give up after this many idle runs file nothing
  agents: []              # which proposers idle may run; empty = all
```

It runs **one agent at a time**, least-recently-run first — as soon as one files
something the executor is no longer idle, so firing the whole roster would just
dump every agent's proposals into an empty backlog at once.

Three things keep this from becoming a loop that burns usage:

- **`minIntervalMinutes` governs cron and idle alike**, so the two paths can't
  double up on the same agent.
- **`maxBacklog`** skips the trigger while work is already waiting. A backlog
  means items need *promoting*, not more proposing.
- **`maxEmptyRuns`** stops triggering once idle runs stop producing anything. It
  resumes on its own when the board changes — you file, promote, or close
  something — rather than needing a restart.

Being idle is a legitimate resting state. If your agents have genuinely run out
of useful work, the right outcome is a quiet team, not a busy one.

Dedup does the heavy lifting here: an idle proposer runs against an unchanged
repo, so its most likely output is a re-proposal of something already on the
board. crew matches new proposals against open work, work completed within
`triager.dedupLookbackDays` (30 by default), and **canceled work regardless of
age** — canceling an issue is how you say "don't do this", and that answer
shouldn't expire on a timer.

One limit worth knowing: dedup compares *titles* (token-set similarity at
`dedupThreshold`). Two genuinely different phrasings of the same idea — "Add
retry logic to the Linear adapter" vs. "Retry failed Linear API calls" — won't
match, and both get filed. Idle runs make near-miss phrasings more likely, since
it's the same agent looking at the same code. If you see duplicates slipping
through, lower `dedupThreshold` before reaching for anything else.

Proposers are also skipped while the executor is at `wipCap`, idle or not —
anything filed then would only queue up behind work that's already waiting.

## Providers

crew drives Claude Code out of the box with live step-by-step streaming and
subscription auth. To use a different agent CLI, point the `agent` config at it —
crew feeds it the prompt, streams its output, and treats the result as the
agent's work. The agent is responsible for setting up its own toolchain; crew
never assumes one.

## Safety

If a task commits and passes verification but then fails to land — a push
rejection, a `gh` outage, an expired token — crew **keeps the worktree** instead
of discarding it. The next cycle finds the existing commit and retries just the
push and PR, with no second agent run and no tokens spent. After three failed
attempts it gives up, removes the worktree, and demotes the issue to your
backlog with a comment. Failures *before* a good commit (no commit, protected
paths touched, verification failed) still clean up, since those need a fresh
attempt.

Every task runs in an isolated git worktree on a throwaway branch; the executor
never touches your main branch. A `noTouch` list protects secrets, migrations,
CI, and infra. Material changes stop for human approval as a PRD, verification
gates run before any PR, and nothing merges without your review. Logs stream to
`.crew/logs/` and each agent run is saved under `.crew/logs/runs/`.
