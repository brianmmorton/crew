import { spawn } from "node:child_process";
import type { CrewConfig, GitPort } from "../types.js";
import { GitAdapter } from "../git/git.js";

/**
 * One verify command's result in a cold worktree, in the order it ran.
 * `skipped` marks commands that never got to run because an earlier one in the
 * chain failed — reported distinctly so a single red app doesn't read as three.
 */
export interface ProbeStep {
  /** App name from `gates.verify`, or "setup" for `gates.setup`. */
  app: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  /** Combined stdout+stderr. Empty for skipped steps. */
  output: string;
}

export interface ProbeResult {
  ok: boolean;
  steps: ProbeStep[];
  /** Set when the probe couldn't run at all (worktree creation failed, etc). */
  error?: string;
}

/**
 * Run one shell command, streaming its output as it arrives while also
 * capturing it. Streaming matters here: `gates.setup` plus a real test suite
 * can run for minutes, and a silent terminal is indistinguishable from a hang.
 */
function runStreaming(
  cmd: string,
  cwd: string,
  onChunk: (s: string) => void,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Verify commands are trusted, user-authored shell strings — the same
    // contract as gates.ts, which runs these exact strings during a real cycle.
    const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (buf: Buffer) => {
      const s = buf.toString();
      output += s;
      onChunk(s);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (e) => resolve({ ok: false, output: `${output}${(e as Error).message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

/** Indent a command's output so it reads as subordinate to the step heading. */
function relay(onChunk: (s: string) => void): (s: string) => void {
  let atLineStart = true;
  return (s: string) => {
    let out = "";
    for (const ch of s) {
      if (atLineStart && ch !== "\n") {
        out += "      ";
        atLineStart = false;
      }
      out += ch;
      if (ch === "\n") atLineStart = true;
    }
    onChunk(out);
  };
}

/**
 * Prove that `gates.setup` + `gates.verify` actually pass in a COLD worktree —
 * a fresh checkout of the base branch with nothing but what git tracks.
 *
 * This exists because the main checkout is a warm environment: it accumulates
 * generated code, build artifacts, and installed tooling that no longer appear
 * in any tracked file. A verify command can lean on one of those without anyone
 * noticing, pass every time by hand, and then fail on every single agent run —
 * where the worktree only ever has what git carries. Generated database clients
 * are the classic case: the types live in `node_modules`, so `tsc` in a cold
 * worktree sees an empty module and reports hundreds of errors that look like
 * the agent's fault and are not.
 *
 * The probe runs each app's verify command SEPARATELY, unlike a real cycle,
 * which chains them with `&&`. Chaining is right during a run (fail fast, don't
 * burn minutes on a doomed branch) but wrong here: the point is to tell the
 * user which of their commands are cold-safe, and `&&` hides every command
 * after the first failure.
 */
export async function verifyInWorktree(
  cfg: CrewConfig,
  git: GitPort,
  onChunk: (s: string) => void = (s) => process.stdout.write(s),
): Promise<ProbeResult> {
  const verify = cfg.gates.verify ?? {};
  const apps = Object.keys(verify);
  if (apps.length === 0) {
    return {
      ok: true,
      steps: [],
      error: "no verify commands configured in gates.verify — nothing to prove",
    };
  }

  // A branch name no real issue can collide with, so a leftover probe worktree
  // is always recognizable and never mistaken for in-flight agent work.
  const branch = "crew/probe-verify";
  const setup = cfg.gates.setup?.trim();
  const steps: ProbeStep[] = [];
  let worktree: string | undefined;

  try {
    // Match a real cycle: worktrees branch from origin/base, not from whatever
    // the user has checked out. Fetching first is what makes this a fair test.
    await git.syncBase();
    worktree = await git.createWorktree(branch);
    onChunk(`  cold worktree at ${worktree}\n`);

    if (setup) {
      onChunk(`\n  ▸ setup  ${setup}\n`);
      const res = await runStreaming(setup, worktree, relay(onChunk));
      steps.push({
        app: "setup",
        command: setup,
        status: res.ok ? "passed" : "failed",
        output: res.output,
      });
      // Every verify command assumes setup's side effects (deps installed,
      // runtime on PATH). Running them after it fails only produces noise.
      if (!res.ok) {
        for (const app of apps) {
          steps.push({ app, command: verify[app], status: "skipped", output: "" });
        }
        return { ok: false, steps };
      }
    }

    for (const app of apps) {
      const command = verify[app];
      onChunk(`\n  ▸ ${app}  ${command}\n`);
      // setup runs in its own shell above, so re-apply it here: it commonly
      // mutates PATH, which does not survive across separate shells.
      const full = setup ? `${setup} && ${command}` : command;
      const res = await runStreaming(full, worktree, relay(onChunk));
      steps.push({
        app,
        command,
        status: res.ok ? "passed" : "failed",
        output: res.output,
      });
    }

    return { ok: steps.every((s) => s.status === "passed"), steps };
  } catch (e) {
    return { ok: false, steps, error: (e as Error).message };
  } finally {
    // The probe branch holds no work worth keeping — always clean up, so a
    // failed probe doesn't strand a worktree that blocks the next attempt. The
    // branch itself is left behind; createWorktree deletes a leftover branch of
    // the same name before recreating, so a re-probe is unaffected either way.
    if (worktree) await git.removeWorktree(worktree);
  }
}

/**
 * Map a failed step to a plain-English cause when the output matches a known
 * cold-worktree failure. These are the mistakes that are genuinely hard to
 * read: the error names a module or binary, never the missing build step, so
 * the output looks like broken source code rather than a broken environment.
 */
export function diagnose(step: ProbeStep): string | undefined {
  const out = step.output;

  // A generated client that lives in node_modules: present in the warm
  // checkout, absent anywhere else, and it fails as "module has no exports".
  if (/has no exported member/.test(out) && /@prisma\/client/.test(out)) {
    return (
      "@prisma/client resolves to an ungenerated stub. Its types are generated " +
      "into node_modules and are not tracked by git, so they don't exist in a " +
      "fresh worktree. Add `prisma generate` to gates.setup (or a root " +
      "postinstall script, which fixes CI and fresh clones too)."
    );
  }
  if (/Cannot find module '\.prisma|@prisma\/client did not initialize/.test(out)) {
    return (
      "The Prisma client was never generated in this worktree. Add " +
      "`prisma generate` to gates.setup or a root postinstall script."
    );
  }
  // Same shape, different generator.
  if (/Cannot find module .*\/(generated|__generated__|gen)\//.test(out)) {
    return (
      "This imports generated code that isn't tracked by git, so it's missing " +
      "in a fresh worktree. Add the codegen step to gates.setup."
    );
  }
  if (/graphql.*generated|codegen/i.test(out) && /Cannot find module/.test(out)) {
    return "Missing GraphQL codegen output — add the codegen command to gates.setup.";
  }
  if (/command not found|: not found$/m.test(out)) {
    const m = out.match(/(?:command not found|not found):?\s*([\w.-]+)/) ?? out.match(/([\w.-]+): command not found/);
    const bin = m?.[1] ? `\`${m[1]}\`` : "A command";
    return (
      `${bin} isn't on PATH inside the worktree. Your shell profile isn't ` +
      "loaded there — put whatever puts it on PATH into gates.setup."
    );
  }
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(out) && !/gates\.setup/.test(out)) {
    return (
      "A module couldn't be resolved. If dependencies are installed by " +
      "gates.setup, check it covers every workspace; if this is generated or " +
      "built output, add the step that produces it."
    );
  }
  if (/ENOENT.*\.env|env(ironment)? variable|is not defined/i.test(out) && /\.env/.test(out)) {
    return (
      "This looks like it needs a .env file. Worktrees don't get one — .env is " +
      "gitignored. Make the check work without it, or have gates.setup provide it."
    );
  }
  if (/ECONNREFUSED|ECONNRESET|could not connect|connection refused/i.test(out)) {
    return (
      "Something tried to reach a service that isn't running (a database, " +
      "Redis, an API). Agent runs are unattended, so a verify command must not " +
      "depend on a service you start by hand."
    );
  }
  return undefined;
}

/** Render a probe result as the summary block printed after a run. */
export function formatProbe(result: ProbeResult): string {
  const lines: string[] = [];
  if (result.error) lines.push(`  ✗ ${result.error}`);

  for (const s of result.steps) {
    const mark = s.status === "passed" ? "✓" : s.status === "failed" ? "✗" : "○";
    lines.push(`  ${mark} ${s.app.padEnd(14)} ${s.status}`);
    if (s.status !== "failed") continue;
    const why = diagnose(s);
    if (why) lines.push(...wrap(why, "      → "));
    // The last few lines are where the actual error text lives; the rest is
    // progress noise from the package manager.
    const tail = s.output.trimEnd().split("\n").filter(Boolean).slice(-3);
    for (const t of tail) lines.push(`        ${t.slice(0, 160)}`);
  }
  return lines.join("\n");
}

/**
 * Run the cold-worktree probe and print it, for `crew doctor --verify-worktree`
 * and the end of `crew setup`. Only needs git, so it builds its own adapter
 * rather than going through buildPorts — that would demand tracker credentials
 * the user may not have entered yet during onboarding.
 */
export async function probeVerify(cfg: CrewConfig): Promise<ProbeResult> {
  console.log("\nProving your verify commands in a cold worktree.");
  console.log(
    "This runs your real gates.setup + gates.verify on a fresh checkout, so it " +
      "can take several minutes.",
  );

  const git = new GitAdapter(cfg.repo.path, cfg.repo.baseBranch);
  const result = await verifyInWorktree(cfg, git);

  console.log("\nCold-worktree verify:");
  console.log(formatProbe(result));
  console.log(
    result.ok
      ? "\nVerify commands pass in a clean worktree — agent runs will get the same result."
      : "\nThese commands fail in a clean worktree even though they may pass in your\n" +
          "checkout. Every agent run will hit this. Fix gates.setup / gates.verify in\n" +
          `${cfg.configDir}/config.yaml, then re-run: crew doctor --verify-worktree`,
  );
  return result;
}

/** Wrap prose to ~76 columns under a hanging indent. */
function wrap(text: string, prefix: string): string[] {
  const width = 76 - prefix.length;
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.map((l, i) => (i === 0 ? prefix : " ".repeat(prefix.length)) + l);
}
