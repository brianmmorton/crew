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
 * Run the configured verify commands inside `worktreePath`.
 *
 * If `apps` is non-empty, only the verify commands for those app names run;
 * if empty, every command in `cfg.gates.verify` runs. A best-effort
 * `pnpm install` runs first (failures ignored). Never throws on verify
 * failure — a non-zero command sets `ok:false` and its output is accumulated.
 */
export async function runVerify(
  cfg: CrewConfig,
  worktreePath: string,
  apps: string[],
): Promise<{ ok: boolean; output: string }> {
  const verify = cfg.gates.verify ?? {};
  const targets =
    apps.length > 0
      ? apps.filter((a) => a in verify)
      : Object.keys(verify);

  let output = "";

  // Best-effort dependency install; ignore failure.
  const install = await runShell("pnpm install", worktreePath);
  output += `$ pnpm install\n${install.output}\n`;

  let ok = true;
  for (const app of targets) {
    const cmd = verify[app];
    if (!cmd) continue;
    const res = await runShell(cmd, worktreePath);
    output += `\n$ [${app}] ${cmd}\n${res.output}\n`;
    if (!res.ok) ok = false;
  }

  return { ok, output };
}
