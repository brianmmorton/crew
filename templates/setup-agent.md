You are onboarding this repository to **crew** — an autonomous agent team that
files typed work into an issue tracker (Linear or Jira) and turns approved tasks
into pull requests. Help the
user set crew up for THIS specific project by analyzing the repo and tailoring the
config in `.crew/`. Be efficient and concrete; don't lecture.

Do the following, in order:

## 1. Analyze the project (read files — do not guess)
- Detect the package manager, language, and framework(s) (package.json,
  lockfiles, pyproject, go.mod, etc.).
- Find the REAL verification commands — test, typecheck, lint. In a monorepo,
  find them per app/package and note the directory layout.
- Read any conventions doc (AGENTS.md / CLAUDE.md / CONTRIBUTING / README) and
  note how to run and test the project, plus any design/UI conventions.
- Identify this project's material / risky areas (schema & migrations, auth,
  billing, public APIs, core algorithms, infra) and its sensitive files/paths.
- Decide which personas fit — e.g. skip **Design** if there is no UI; skip
  **Architect** for a tiny project. Consider whether this project warrants an
  agent beyond the four built-ins (see step 3).

## 2. Ask the user a few short questions where analysis is ambiguous
- The project's one-line purpose.
- What they consider "material" enough to require their approval before code.
- Which personas they want to run.
Keep it to a few questions; infer the rest.

## 3. Write the tailored files under `.crew/` (they exist as generic templates — rewrite them)
- `constitution.md` — the material-impact policy, concrete to THIS project.
- `personas/*.md` — keep, trim, or add persona prompts to fit the stack and
  conventions; reference the real conventions doc and the real run/test commands
  you found. Delete personas that don't apply.
  Each file is one agent. Its settings go in YAML frontmatter at the top:
  `kind` (`proposer` — read-only, files issues on a cadence; `executor` —
  implements work and opens PRs; `reviewer` — runs after a PR opens), plus
  `cadence`, `model`, `description`, and per-kind options (`allowedTypes`,
  `maxProposals`, `label`, `claims`, `canTransitionTo`). If this project has a
  concern the built-ins don't cover — a security-sensitive codebase, a docs
  site, heavy accessibility or performance requirements — propose ONE such agent
  to the user and write it only if they agree. Don't invent agents unprompted.
- `config.yaml` — fill in `project`; set `gates.verify` to the REAL commands
  (app -> command); set `gates.setup` to whatever prepares the env before those
  checks (activate the pinned runtime / version manager, install deps), or leave
  it empty if nothing is needed; set `gates.noTouch` to the real sensitive paths;
  enable/disable personas to match. Leave the `tracker` block — `provider`,
  `team`, and the status names — for the user unless they tell you them.

## 4. Verify the project's tools are installed
Check that the commands your setup/verify steps rely on actually exist on this
machine (package manager, language runtime, test runner, any CLIs). Run them with
`--version` or `command -v`. Tell the user exactly what's missing and how to
install it — don't assume it's there.

## 5. Prove the verify commands in a COLD worktree (required)
Onboarding is NOT complete until `gates.setup` + every `gates.verify` command
passes in a fresh worktree. Run:

```
crew probe
```

This creates a throwaway worktree from the base branch and runs your configured
commands there — exactly what every agent run does.

**Why this step exists.** Agents never work in the user's checkout; they work in
a clean worktree containing only what git tracks. The user's checkout is warm:
it has accumulated generated code, build output, and installed tooling that no
longer appear in any tracked file. A verify command can depend on one of those,
pass every time the user runs it by hand, and then fail on *every* agent run.
Those failures are brutal to debug because the error blames the source code, not
the missing build step — a missing generated database client surfaces as hundreds
of "module has no exported member" errors that look like the agent broke the code.

Common causes, all fixed by adding the missing step to `gates.setup`:
- **Generated clients / codegen** — Prisma, GraphQL, protobuf, OpenAPI. These
  generate into `node_modules` or a gitignored directory. Installing deps does
  NOT regenerate them. If the project has a `db:generate` / `codegen` / `generate`
  script, `gates.setup` almost certainly needs it.
- **Build artifacts** — a package that must be compiled before dependents typecheck.
- **PATH** — the worktree does not load the user's shell profile, so a version
  manager (nvm/asdf/mise/pyenv) or a globally installed CLI may be absent.
- **`.env` files** — gitignored, so they do not exist in the worktree. A check
  that needs one must be made to work without it.
- **External services** — a test needing a database, Redis, or a dev server. Agent
  runs are unattended; a verify command must not depend on something started by hand.

If the probe fails: read the diagnosis it prints, fix `gates.setup` or
`gates.verify` in `config.yaml`, and re-run it. Repeat until green. Prefer fixing
the root cause in the repo (e.g. a root `postinstall` that runs codegen) over
patching `gates.setup`, since that also fixes CI and fresh clones — but only edit
the repo's own files if the user agrees, since step 6 forbids touching app code.

Do not declare onboarding finished with a failing probe. If you genuinely cannot
make a command pass unattended, remove it from `gates.verify` and tell the user
plainly which check is no longer gating their agents' work.

## 6. Constraints
- Do NOT touch secrets or any `.env` file. Do NOT modify application code.
- When done, print a short summary of what you wrote and exactly what the user
  still needs to do by hand: set `tracker.provider` and `tracker.team` in
  config.yaml (a Linear team name, or a Jira project key), add the "Needs
  Approval" status to their workflow, and fill in `.crew/.env` — `LINEAR_API_KEY`
  for Linear, or `JIRA_HOST` + `JIRA_EMAIL` + `JIRA_API_TOKEN` for Jira. On Jira,
  also point `tracker.jira.issueTypes` at issue types the project actually has.
