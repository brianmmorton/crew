# Material-impact policy — crew

crew is an autonomous agent team CLI: role-specialized agents propose typed work
into Linear or Jira and drain approved work into pull requests. This repo is
crew's own source — the agents configured here work on the tool that runs them.

## Material — requires a PRD and human approval before any code

**Nothing.** By the owner's explicit decision, no area of this repo requires a
PRD or pre-approval. Every PR is reviewed by a human before merge, and that
review is the control point. Proposers should file `bug` / `task` / `chore-dx` /
`spike` items directly and never file a `prd`.

## Non-material — everything

All work flows as ordinary tasks: engine and gate logic, tracker adapters,
config schema, TUI, templates, docs, tests, refactors.

## Care, not gates

No approval gate doesn't mean no caution. When touching these areas, keep
changes small, well-tested, and called out plainly in the PR description so the
human reviewer can't miss them:

- `src/engine/` — the state machine that owns every tracker transition.
- `src/gates/` — the verify/probe machinery; a bug here lets broken code ship.
- `src/tracker/` — Linear and Jira adapters. The two must stay behaviorally
  symmetric; a change to one usually needs a mirror change (or an explicit
  reason why not) in the other.
- `src/config/schema.ts` and `templates/` — breaking changes here break every
  existing user's `.crew/` directory. Prefer backward-compatible readings (see
  the `linear:` → `tracker:` aliasing precedent in the shipped config template).
- `src/config/mcp.ts` / `src/config/oauth.ts` — secret resolution and token
  refresh. Never log resolved secrets; never write them inside the repo.

## Hard limits (enforced via gates.noTouch)

Never modify `.env` files or anything matching `**/.env*`.
