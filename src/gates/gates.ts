import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { CrewConfig } from "../types.js";

const pExec = promisify(exec);

/**
 * Run a single user-authored shell command from `cwd`, returning combined
 * stdout+stderr and whether it exited zero. Verify commands are trusted,
 * user-authored shell strings, so a shell is intentional here.
 */
async function runShell(
  cmd: string,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await pExec(cmd, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "");
    return { ok: false, output };
  }
}

/**
 * Run the configured verify commands inside `worktreePath`. Language-agnostic:
 * crew assumes no toolchain. An optional `gates.setup` command (whatever the
 * project needs to prepare its env — activate a version manager, install deps)
 * runs first in the SAME shell so its environment applies to the checks.
 *
 * If `apps` is non-empty, only those apps' verify commands run; if empty, every
 * command in `cfg.gates.verify` runs. No verify commands configured => no gate
 * (ok:true), and the agent's own verification + PR review are the safety net.
 * Never throws — a non-zero exit sets `ok:false`.
 */
export async function runVerify(
  cfg: CrewConfig,
  worktreePath: string,
  apps: string[],
): Promise<{ ok: boolean; output: string }> {
  const verify = cfg.gates.verify ?? {};
  const setup = cfg.gates.setup?.trim();
  const targets = apps.length > 0 ? apps.filter((a) => a in verify) : Object.keys(verify);
  const cmds = targets.map((a) => verify[a]).filter((c): c is string => !!c);

  if (cmds.length === 0) {
    return { ok: true, output: "(no verify commands configured — gate skipped)" };
  }

  // Run setup + all verify commands in one shell so setup's env carries through.
  const full = [setup, ...cmds].filter((s) => s && s.length > 0).join(" && ");
  const res = await runShell(full, worktreePath);
  return { ok: res.ok, output: `$ ${full}\n${res.output}` };
}
