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

Install globally and `crew` is on your `PATH` — nothing to add to your shell:

```bash
npm install -g @brianmorton/crew
# or: pnpm add -g @brianmorton/crew
# or: yarn global add @brianmorton/crew

crew --version
```

Prefer to pin it per project? Install it as a dev dependency and run it through
your package manager, which puts `node_modules/.bin` on `PATH` for you:

```bash
npm install -D @brianmorton/crew
npx crew status                  # npm
pnpm exec crew status            # pnpm (`pnpm crew status` also works)
```

Inside `package.json` scripts, `crew` resolves on its own:

```json
{ "scripts": { "crew": "crew run" } }
```

You never need to type `./node_modules/.bin/crew`.

<details>
<summary>Working on crew itself</summary>

```bash
git clone https://github.com/brianmmorton/crew && cd crew
npm install
npm run build
npm link          # symlinks your checkout onto your PATH as `crew`
npm test
```

`npm run dev` rebuilds on change. To undo the link later: `npm unlink -g @brianmorton/crew`.
</details>

> **pnpm users:** `pnpm add -g` needs a global bin directory. If you see
> `ERR_PNPM_NO_GLOBAL_BIN_DIR`, run `pnpm setup` once (it adds the directory to
> your shell profile), restart your shell, and retry.

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
# Code host — Bitbucket Cloud (app passwords stopped working 28 Jul 2026):
#   BITBUCKET_ACCESS_TOKEN   Repository settings → Access tokens
#                            scopes: pullrequest:write, repository:write
#   ...or an Atlassian API token, with your account email:
#   BITBUCKET_EMAIL / BITBUCKET_API_TOKEN   (see "Using Bitbucket" for scopes)
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

#### Permissions

A Jira API token has **no scopes of its own** — it inherits every permission of
the Atlassian account that created it. A token made from an admin account *is*
an admin token. So create one from a dedicated service account granted only
these project permissions:

| Permission | Why crew needs it |
|---|---|
| Browse Projects | Read the board — required by every other operation |
| Create Issues | File proposals |
| Edit Issues | Update fields on existing work |
| Transition Issues | Move items between statuses |
| Assign Issues | Assign work to itself |
| Add Comments | Post PR links and review notes |
| Link Issues | Link PRDs to the work they spawn |

The service account also needs **Assignable User** in the project — a separate
permission from *Assign Issues*, held by the person being assigned rather than
the one doing the assigning. Without it, assignment fails.

Two more things that bite in practice: Jira API tokens **expire** (one year by
default), and a lapsed one fails as a hard `401`. And JQL search filters by
permission rather than rejecting — an account missing *Browse Projects* gets an
empty result set with HTTP 200, which looks like an empty backlog rather than an
error.

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

Then put credentials in `.crew/.env`. Two options — a **Repository Access
Token** is recommended, since it isn't tied to anyone's personal account:

```bash
BITBUCKET_ACCESS_TOKEN=...
```

Create it under *Repository settings → Access tokens* with these scopes:

| Scope | Why crew needs it |
|---|---|
| `pullrequest:write` | Open PRs and comment on them |
| `repository:write` | Push the branch — omit if you push over SSH |

Or use an **Atlassian API token with scopes**, paired with your account
**email** (not your username), from *id.atlassian.com → Security → API tokens*:

```bash
BITBUCKET_EMAIL=you@example.com
BITBUCKET_API_TOKEN=...
```

| Scope | Why crew needs it |
|---|---|
| `write:pullrequest:bitbucket` | Open pull requests |
| `read:pullrequest:bitbucket` | Comment on pull requests |
| `read:repository:bitbucket` | Read the repository |
| `write:repository:bitbucket` | Push the branch — omit if you push over SSH |

> Bitbucket API token scopes **do not imply one another** — unlike the older
> OAuth scopes, `write:pullrequest:bitbucket` does *not* grant read access.
> Tick all four explicitly.

> **App passwords no longer work.** Atlassian removed them on **28 July 2026**.
> If you have `BITBUCKET_USERNAME` / `BITBUCKET_APP_PASSWORD` in your `.env`,
> requests will fail with `401` — switch to one of the options above. crew warns
> at startup when it sees them.

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
  proposals go straight to ready), `executable.requireLabels` /
  `executable.excludeLabels` (label gate on what the executor may claim — see
  below), and a `jira` block for Jira-specific issue types and priorities. The
  older `linear:` spelling is still accepted.
- **budget** — `implementerWorkers` (how many items are implemented at once;
  default 1, max 8), plus usage back-off and poll intervals.
- **personas** — your agents; see below.

The `.crew/` directory name can be overridden with the `CREW_DIR` env var.

## Check your verify commands work where agents run them

```bash
crew probe
```

Agents work in a fresh git worktree — a clean checkout with only what git
tracks. Your own checkout has much more: generated clients, build output,
installed tooling, a `.env`. A verify command can quietly depend on one of those,
pass every time you run it, and then fail on **every** agent cycle.

`crew probe` runs your real `gates.setup` + `gates.verify` in a cold worktree and
tells you which commands are safe there. When one fails it explains why in plain
English — missing codegen, a binary that isn't on `PATH`, a service that isn't
running — rather than leaving you with a stack trace that looks like broken
source code.

It runs your actual test suite, so it can take minutes. `crew setup` runs it at
the end, `crew doctor` offers it, and you can run it yourself any time. Skip the
offer in scripts with `crew doctor --no-probe`.

## When a cycle fails

A run can die at several points — during the agent run, the git work, the verify
gate, the push, or the tracker update — and crew tries to resume rather than
start the item over. What happens depends on how far it got:

| Where it failed | What crew does |
|---|---|
| Agent made no commit | Item returns to the backlog; the worktree is discarded |
| Verify gate failed | Commit and failure output are **kept**; the next cycle re-runs the agent in the same worktree with the failing output, telling it to amend. Twice, then the item is demoted |
| Push / PR / tracker update | Commit is kept; the next cycle retries just the plumbing — no agent run, no tokens. Three times, then demoted |
| Agent committed outside its worktree | Nothing is discarded and the item is labelled `crew:needs-human` — it is never auto-resumed |

Two labels make this visible on the board: **`crew:stuck`** (crew will pick it
back up) and **`crew:needs-human`** (it will not — this label always excludes an
item from selection, whatever your `executable` gate says). Both names are
configurable under `tracker.labels`.

`crew status` and `crew worktrees` list everything in flight, including work
abandoned by a run that died. Release one by hand with:

```bash
crew unclaim                     # what is currently held
crew unclaim ABC-1               # release one item
crew unclaim --all-stale         # release everything whose process is gone
crew unclaim ABC-1 --reset       # also clear retry counters and any pending fix
```

## Running several items at once

`budget.implementerWorkers` (default 1) sets how many items are implemented
concurrently. Each worker takes a per-item lock before touching a ticket, so two
workers can never work the same one — the tracker has no compare-and-set to
arbitrate with, so this is what makes concurrency safe. A worker whose process
dies leaves a lock behind, which the next run reclaims automatically.

Turn it up with `worktrees.reuse: true`, or each worker pays for its own full
checkout every cycle. The pool defaults to one slot per worker.

Note this coordinates workers on **one machine**. Two crew instances on
different machines pointed at the same tracker can still double-claim.

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
| `mcp` | all | External tool servers to grant ([see below](#external-tools-mcp)) |

`allowedTypes`, `maxProposals`, and `canTransitionTo` are enforced by the engine
after the agent runs, not just requested in the prompt — a custom agent can't
flood your backlog or move an issue somewhere you didn't allow.

### Custom executors

An executor claims work by label. Give it `claims: ["type:docs"]` and any ready
item carrying that label routes to it instead of the implementer; everything
unclaimed still goes to the implementer, so adding one never strands work. One
agent runs at a time under the existing `wipCap`.

Note that `claims` is *routing*, not filtering: it decides which executor works
an item that was already selected, so an item labelled for an executor you never
defined still gets worked, by the implementer.

### Filtering what the executor picks up

To control which ready items are eligible at all, use the tracker-level label
gate. Both lists default to empty, which means every ready item is fair game:

```yaml
tracker:
  executable:
    requireLabels: ["crew"]      # only work items carrying one of these
    excludeLabels: ["blocked"]   # never work items carrying one of these
```

`requireLabels` is an opt-in allowlist — useful on a board you share with
people, where crew should only touch work explicitly marked for it. Items with
none of these labels are skipped, including unlabeled ones. `excludeLabels` is a
denylist that leaves everything else (unlabeled work included) eligible, and it
wins on conflict: an item tagged both `crew` and `blocked` is not worked.

The gate applies to Linear and Jira alike, and is pushed into the tracker query
so excluded items don't crowd out real work in the page crew fetches. It gates
selection only — an item already in progress is unaffected by a label change.

You don't need a new label to express "only work crew's own output": every item
an agent files already carries `agent-authored`, so `requireLabels:
["agent-authored"]` closes the loop with no extra config. Note that this also
excludes anything *you* file by hand, since only crew's creates get that label.
A persona's own `label` works the same way for a narrower slice — set
`personas.qa.label: "triage:auto"` and gate on `triage:auto` to drain only QA's
findings.

Since the gate reads labels the tracker owns, a name that matches nothing on the
board stalls the executor silently. Two things catch that: `crew doctor` reports
how many ready items pass the gate, and the run log warns (rather than reporting
a plain idle) whenever items are waiting but none survive the gate.

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

### External tools (MCP)

By default an agent only knows what it can read in the repo. Grant it MCP
servers and it can also pull in outside context — production errors, analytics,
a docs index — so QA files the bugs that are *actually* firing rather than the
ones it imagines.

Define the servers once, then grant them per agent by name:

```yaml
# config.yaml — committed, so it holds ${PLACEHOLDERS}, never real keys
mcpServers:
  sentry:
    command: "npx"
    args: ["-y", "@sentry/mcp-server@latest"]
    env:
      SENTRY_AUTH_TOKEN: "${SENTRY_AUTH_TOKEN}"
    allowedTools: ["find_errors", "get_issue_details"]   # optional, advisory (see below)

personas:
  qa:        { cadence: "0 */6 * * *", mcp: [sentry] }
  architect: { cadence: "0 9 * * 2,5", mcp: [sentry] }
  implementer: { cadence: "continuous" }                 # no mcp key = no tools
```

The real values go in `.crew/.env` or `~/.crew/env`, the same place as your
other secrets. crew resolves them at spawn time into a temp file outside the
repo, hands it to the agent CLI, and deletes it when the run ends — nothing
sensitive is ever written into your repo or committed.

A few deliberate behaviours:

- **Grants are explicit.** An agent with no `mcp:` key gets no servers at all,
  and never inherits the ones you've configured in Claude Code or Codex
  yourself. Your crew config alone decides what a run can reach, so it behaves
  the same on a teammate's machine or a cron box.
- **A missing credential skips the run**, naming the variable, instead of
  letting the agent burn a cycle discovering it can't authenticate.
- **A typo'd server name fails at startup**, not silently at run time, whether
  you wrote the grant in frontmatter or in `config.yaml`.
- **Set `mcp: []` in `config.yaml`** to revoke a grant from a shared persona
  file without editing that file.

**`allowedTools` is advisory, not enforced.** Headless runs skip the permission
system entirely — there's nobody to answer a prompt — which makes any CLI-level
tool allowlist inert. crew states the pinned tools in the agent's prompt, and a
model can ignore an instruction. Treat it as documentation of intent.

So the boundaries that actually hold are: **which servers a persona is granted**,
and **the scope of the token you issue**. Grant read-only servers and issue
read-only tokens. crew's whole model is that agents *propose* and the engine
files — dedup, `allowedTypes`, `maxProposals`, and the PRD approval gate all
live there. A server that can create issues routes around every one of them;
`crew doctor` warns if you grant one, but only the token scope stops it.

Non-Claude CLIs need to be told how they take an MCP config, since they all
spell it differently:

```yaml
agent:
  provider: "codex"
  command: "codex"
  mcpConfigFlag: "--mcp-config"
  mcpStrictFlag: "--strict-mcp-config"   # omit if the CLI has no equivalent
```

Leave `mcpConfigFlag` unset and granted servers are skipped with a warning
rather than failing the cycle.

#### OAuth-protected servers

Some MCP servers require OAuth instead of a static token. crew's own runs are
headless — cron-fired, nobody at a keyboard to click through a consent screen —
so the browser step happens exactly once, ahead of time, from your terminal.
After that, crew refreshes the access token itself before every run, no
browser involved:

```yaml
mcpServers:
  linear:
    url: "https://mcp.linear.app/mcp"
    type: "http"
    oauth:
      authorizationUrl: "https://mcp.linear.app/authorize"
      tokenUrl: "https://mcp.linear.app/token"
      clientId: "${LINEAR_MCP_CLIENT_ID}"
      # clientSecret: "${LINEAR_MCP_CLIENT_SECRET}"   # confidential clients only
      scopes: "read"
```

```
crew mcp login linear     # opens a browser once; stores a refresh token
crew mcp status           # which oauth servers are logged in
crew mcp logout linear    # forget the stored token
```

The token is stored under `~/.crew/oauth/<server>.json` (mode `0600`), never
in the repo. At spawn time crew exchanges the refresh token for a fresh access
token and injects it as `Authorization: Bearer <token>` — you never set
`headers` yourself for an `oauth` server. If the stored token can't be
refreshed (revoked, or `crew mcp login` was never run), that persona's run is
skipped with a message telling you which server to log back into, the same way
a missing `${VAR}` skips a run rather than failing it silently. `crew doctor`
reports login state for every OAuth server a persona is granted.

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
