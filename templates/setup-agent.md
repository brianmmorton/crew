You are onboarding this repository to **crew** — an autonomous agent team that
files typed work into Linear and turns approved tasks into pull requests. Help the
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
  **Architect** for a tiny project.

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
- `config.yaml` — fill in `project`; set `gates.verify` to the REAL commands
  (app -> command); set `gates.noTouch` to the real sensitive paths; enable/disable
  personas to match. Leave the Linear `team` and status names for the user unless
  they tell you them.

## 4. Constraints
- Do NOT touch secrets or any `.env` file. Do NOT modify application code.
- When done, print a short summary of what you wrote and exactly what the user
  still needs to do by hand: set the Linear `team` in config.yaml, add the
  "Needs Approval" status in Linear, and fill in `.crew/.env`.
