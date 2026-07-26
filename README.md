# crew

An autonomous agent team for a code repo. Role-specialized agents **propose**
typed work into Linear, anything **material** is gated behind a human-approved
PRD, and an **executor** drains approved work into pull requests — all running on
your machine against your Claude subscription, backing off when your usage window
is spent.

It's project-agnostic: the engine knows nothing about any specific repo. Each
target repo gets a versioned `.crew/` folder (config + the material-impact
constitution + persona prompts). Point `crew` at a different repo's `.crew/`
and it just works.

## Design in one breath

- **Agents are stateless workers; the engine owns all state.** Proposer personas
  (QA, Design, Architect) return structured JSON proposals — they never write to
  Linear. The Implementer produces a commit — it never touches Linear. The engine
  performs every Linear transition and all git/PR work deterministically.
- **Linear is the single source of truth** and your review/approval surface.
- **Two gates in code, not convention:** the Implementer can't claim a task whose
  parent PRD isn't approved, and no PR opens until the affected app's verify
  script passes.

## What's implemented (Phase 1)

- `crew init` — scaffold generic `.crew/` templates into a repo (and gitignore `.crew/.env`).
- `crew setup` — onboard a repo: an agent analyzes it and tailors the personas,
  constitution, and config to that project, then sets up `.env` + `.gitignore`.
- `crew once <persona>` — one cycle of `implementer | qa | design | architect`.
- `crew run` — run the whole team in one process: the always-on executor loop
  (WIP-capped, usage-limit back-off) plus the proposers firing on their cadence.
  On startup it runs any proposer that's due (never run, or a missed tick) so you
  see activity immediately. In a terminal it accepts single-key controls:
  `q`/`d`/`a` run QA/Design/Architect now, `i` nudges the executor, `p` pauses/
  resumes, `s` prints status, `Ctrl-C` quits. `--no-proposers` = executor-only;
  `--kickoff` = force every proposer to run once at startup.
- `crew status` — backlog / WIP counts + config summary.
- Linear client (selection query, state machine, dedup-before-create, label/issue
  creation), git/worktree/PR plumbing via `gh`, verify + no-touch gates, the
  headless-Claude persona runner with usage-limit detection, and the self-review
  loop that files `chore-dx` friction items.

**Deferred (documented follow-ups):** auto-decomposition of an approved PRD into
sub-issues, multiple parallel Implementer workers (`implementerWorkers > 1`), and
a standalone Triager sweep that merges pre-existing duplicates (dedup currently
happens at create-time, which covers the common case).

## Config directory

crew stores its per-project config in **`.crew/`** — deliberately *not* `.agents/`,
which is claimed by the emerging [.agents Protocol](https://dotagentsprotocol.com/)
and other tooling. If `.crew` is already taken in a repo, override the name with
the `CREW_DIR` env var (e.g. `CREW_DIR=.crew-agents crew setup`). `init`/`setup`
never overwrite existing files, so pointing crew at a directory that already has
content is safe.

## Prerequisites

- Node 20+.
- The `claude` CLI, authenticated for headless use: run `claude setup-token` once
  and export `CLAUDE_CODE_OAUTH_TOKEN` (an interactive login won't work under
  launchd/cron).
- `gh` (GitHub CLI), authenticated: `gh auth login`.
- A Linear personal API key exported as `LINEAR_API_KEY`.

## Linear setup (one time)

1. Add a workflow status named **Needs Approval** (type: unstarted) to your team.
   The default Backlog / Todo / In Progress / In Review / Done already match.
2. Type labels (`type:bug`, `type:task`, `type:prd`, `type:chore-dx`) and the
   `agent-authored` / `agent:*` labels are **created automatically** on first use
   — you don't need to make them by hand.

## Install

```bash
tar xzf crew-src.tgz && cd crew
npm install
npm run build
npm link          # puts `crew` on your PATH (or: npm i -g .)
```

(Or install the prebuilt package tarball directly: `npm i -g ./brianmmorton-crew-0.1.0.tgz`.)

## Use it in a repo

```bash
cd ~/your-project
crew setup                       # an agent tailors .crew/ to THIS repo, then sets up .env + .gitignore
git add .crew && git commit -m "chore: add crew agent config"   # (.env stays gitignored)

# Fill in the two secrets in .crew/.env (crew reads it automatically — no shell exports):
#   LINEAR_API_KEY           — Linear → Settings → Security & access → Personal API keys
#   CLAUDE_CODE_OAUTH_TOKEN  — run `claude setup-token`
# For the launchd/cron setup, put the same two lines in ~/.crew/env instead
# (launchd ignores your shell rc). Precedence: shell env > .crew/.env > ~/.crew/env.
# Also set the Linear `team` in .crew/config.yaml and add a "Needs Approval" status.

crew status                     # sanity check: counts + config
crew once qa                    # dry-run one proposer; check your Linear Backlog
# seed a Todo issue in Linear, then:
crew once implementer           # watch it open a PR
crew run                        # run the whole team: executor + proposers on cadence
crew run --kickoff              # ...and fire the proposers once right now, too
```

## Running it unattended

`crew run` already runs the executor *and* the scheduled proposers in one
process, so a single always-on launchd job is all you need (no separate cron
entries per persona). Example LaunchAgent
(`~/Library/LaunchAgents/com.crew.scoutsense.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.crew.scoutsense</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>/opt/homebrew/bin/crew</string><string>run</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/macuser/Sites/scoutsense</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LINEAR_API_KEY</key><string>lin_api_...</string>
    <key>CLAUDE_CODE_OAUTH_TOKEN</key><string>...</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/macuser/.crew/scoutsense.out.log</string>
  <key>StandardErrorPath</key><string>/Users/macuser/.crew/scoutsense.err.log</string>
</dict></plist>
```

That one job runs the whole team. (You can still run an individual persona
on demand with `crew once qa` etc.)

## Safety

Isolated worktree per task; the executor never works on `main`; the no-touch list
protects `.env*`, migrations, CI, and infra; two verify gates (the agent's own and
the engine's) precede any PR; and nothing merges without your review.
