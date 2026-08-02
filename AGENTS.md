# AGENTS.md — working on crew

This file is for agents (and humans) **writing code in this repo**. It is not
the file crew generates into users' projects — see "Two AGENTS.md files"
below, and read that section before anything else, because it carries the one
documentation rule that changes here most often violate.

## What crew is

crew runs an autonomous team of role-specialized coding agents against a repo:
**proposers** read the repo and file typed work items into an issue tracker
(Linear or Jira), **executors** claim items and implement them in isolated git
worktrees behind verify gates, and **reviewers** comment on the PRs that
result. A TUI (`crew`) supervises the whole loop. Agents are **stateless
workers**: they return proposals, commit outcomes, or review verdicts, and the
engine performs every tracker mutation, git operation, and PR action
deterministically. That split — agents suggest, the engine decides and acts —
is the design principle behind most of what looks unusual here.

## Two AGENTS.md files — and the documentation rule

| File | Audience | Owner |
|---|---|---|
| `AGENTS.md` (this file, repo root) | agents coding **on** crew | maintainers |
| `templates/agents/AGENTS.md` | agents working **in a repo that uses crew** | crew itself |

The template is stamped with the crew version and copied into every user
repo as `.crew/AGENTS.md` by `crew` / `init` / `setup` / `doctor` /
`agent add|new` (see `src/setup/agentsDoc.ts`). It promises, in its own text,
that its `config.yaml` field reference is "kept in sync with the config
schema, so nothing here is aspirational". That promise is kept by hand — by
you, now:

**Any user-visible change MUST update `templates/agents/AGENTS.md` in the
same commit.** Concretely:

- New/changed field in `src/config/schema.ts` or `PersonaConfig`/`AgentDef`
  in `src/types.ts` → the field reference in the template, plus the config
  table in `README.md`, plus the frontmatter shape in
  `templates/add-agent.md` (the `crew agent add` designer prompt — if it
  doesn't know a feature exists, it designs agents without it; this has
  happened and produced a persona that committed to a user's checkout).
- New/changed CLI command → the commands tables in the template and README.
- New agent kind, mode, or lifecycle behavior → the "What crew does" section
  of the template.

Do not bump the template's version stamp by hand — `{{CREW_VERSION}}` is
filled from `package.json` at generation time, and user repos regenerate
whenever their stamp is older than the installed version.

## Map of the code

- `src/types.ts` — the shared contract: domain types, `PersonaConfig`,
  `AgentDef`, and every `*Port` interface. Modules agree on this file and
  nothing else; read its header comment first.
- `src/engine/` — the deterministic core. `loop.ts` (executor workers, WIP
  cap, idle tracking), `cycles.ts` (one implementer/proposer/reviewer cycle;
  every gate and guardrail lives here), `drain.ts` (run-to-completion
  proposer sessions), `schedule.ts` (pure scheduling decisions), `claim.ts`
  (per-item locks), `context.ts` (prompt assembly), `ports.ts` (wires
  adapters into a `Ports` bundle).
- `src/tracker/linear/`, `src/tracker/jira/` — `TrackerPort` adapters.
  Nothing outside these directories may know which tracker is in use.
- `src/agent/` — persona discovery/config merging (`agents.ts`) and the
  coding-agent CLI adapters (`claude.ts` streams headless Claude Code;
  `generic.ts` drives any other CLI).
- `src/git/` — worktrees, the reusable worktree pool, forge (GitHub/
  Bitbucket) PR operations.
- `src/gates/` — no-touch globs and the verify commands.
- `src/config/` — zod schema (`schema.ts`), loading/normalization
  (`load.ts`), MCP server resolution (`mcp.ts`, secrets via `${VAR}`).
- `src/tui/` — the Ink UI. `bootstrap.ts` runs everything behind the React
  tree; valtio stores under `stores/` are the only bridge to components;
  every manual/scheduled run goes through `runManager.ts` (one child process
  per agent, the single choke point).
- `src/cli/index.ts` — every `crew` command.
- `templates/` — everything scaffolded into user repos, plus the
  `agent add` / `setup` conversation prompts.

## Invariants to preserve

- **The engine owns all state.** An agent result is data; only engine code
  transitions issues, pushes branches, or opens PRs. Never hand a persona a
  tool path that writes to the tracker or repo directly.
- **Proposers and reviewers are read-only, enforced in depth**: their runs
  get `disallowedTools` (Edit/Write/...), and `proposerCycle` snapshots the
  checkout and fails any run that produced commits. Weakening either layer
  needs a very good reason.
- **Ports, not providers.** Code outside an adapter directory talks to
  `TrackerPort`/`GitPort`/`PersonaPort`. New tracker/forge/agent support is a
  new adapter, not a conditional.
- **Decisions are pure, effects are thin.** Scheduling and drain logic live
  in dependency-free functions (`schedule.ts`, `decideDrainStep`) that tests
  call directly; the callers own clocks, processes, and I/O. Follow that
  split for any new policy logic.
- **One agent, one live run.** `runManager`/`isRunning` guarantee an agent
  never runs twice concurrently; claims (`engine/claim.ts`) guarantee two
  workers never work one item. Anything that spawns runs must go through the
  existing choke points.
- **Failures are loud and attributable.** Every non-idle cycle outcome gets a
  log line at the right severity, run transcripts are persisted via
  `recordRun`, and tracker comments/labels (`crew:stuck`, `crew:needs-human`)
  make failures visible on the board. A silent failure is a bug even when the
  behavior is otherwise correct.

## Writing code here

- TypeScript, ESM, Node ≥ 18. Relative imports use the `.js` suffix
  (`from "./cycles.js"`), including for `.ts` sources.
- **Comment style is load-bearing in this repo**: comments explain *why* — a
  constraint, a tradeoff, a failure mode that was actually observed — not
  what the next line does. Match the density and register of the file you're
  editing; a bare mechanical diff with no rationale usually isn't done.
- Tests are `node:test` + `assert/strict`, colocated as `*.test.ts` next to
  the module. Fakes are minimal object literals cast through `as unknown as`
  — see `cycles.test.ts` — not mocking frameworks. Extract pure decision
  functions rather than testing through I/O.
- No new runtime dependencies without strong justification; the current set
  (commander, croner, ink, valtio, zod, yaml, SDKs for Linear) is deliberate.
- Verify with `npm run typecheck` and `npm test` (both must be clean);
  `npm run crew` runs the CLI from source against whatever repo you point it
  at (`CREW_REPO=... npm run crew -- agents`).
- This repo dogfoods crew: `.crew/` here is a real, live config. Don't break
  it, and don't commit experiments into it.
