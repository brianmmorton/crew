import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CrewConfig, Logger } from "../types.js";
import { loadEnvFiles } from "./env.js";
import { REQUIRED_ENV } from "../tracker/factory.js";
import { FORGE_ENV, forgeCredentialsPresent, forgeEnvHint } from "../git/forge/factory.js";

const pExecFile = promisify(execFile);

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  /** Soft checks warn but don't fail the overall result. */
  soft?: boolean;
}

async function cmd(bin: string, args: string[] = ["--version"]): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await pExecFile(bin, args);
    return { ok: true, detail: (stdout || stderr).split("\n")[0].trim() };
  } catch (e: unknown) {
    const err = e as { code?: string; stderr?: string; message?: string };
    if (err.code === "ENOENT") return { ok: false, detail: "not found on PATH" };
    return { ok: false, detail: (err.stderr || err.message || "error").split("\n")[0].trim() };
  }
}

/**
 * Check that the tools and secrets crew needs are present. Returns true if all
 * hard checks pass. With quiet=true, only failures are logged (for run startup);
 * otherwise the full checklist is printed (for `crew doctor` / setup).
 */
export async function runDoctor(
  cfg: CrewConfig,
  logger: Logger,
  quiet = false,
): Promise<boolean> {
  loadEnvFiles(cfg.configDir);

  const checks: Check[] = [];

  const git = await cmd("git");
  checks.push({ name: "git", ...git, hint: "install git" });

  // Code host. GitHub authenticates through the `gh` CLI; Bitbucket has no CLI
  // to check, so its credentials are verified as env vars below.
  if (cfg.repo.forge === "github") {
    const gh = await cmd("gh");
    checks.push({ name: "gh (GitHub CLI)", ...gh, hint: "brew install gh" });
    if (gh.ok) {
      const auth = await cmd("gh", ["auth", "status"]);
      checks.push({
        name: "gh auth",
        ok: auth.ok,
        detail: auth.ok ? "authenticated" : "not logged in",
        hint: "gh auth login",
      });
    }
  } else {
    const ok = forgeCredentialsPresent(cfg.repo.forge);
    checks.push({
      name: `${cfg.repo.forge} credentials`,
      ok,
      detail: ok ? "set" : `missing (${forgeEnvHint(cfg.repo.forge)})`,
      hint: `add ${FORGE_ENV[cfg.repo.forge][0].join(" + ")} to ${cfg.configDir}/.env`,
    });
  }

  // Agent CLI. "claude" is the built-in adapter; any other provider drives an
  // external binary named by `agent.command`.
  if (cfg.agent.provider === "claude") {
    const claude = await cmd("claude");
    checks.push({ name: "claude CLI", ...claude, hint: "install Claude Code" });
  } else {
    const bin = cfg.agent.command?.trim();
    if (bin) {
      const got = await cmd(bin);
      checks.push({
        name: `${cfg.agent.provider} CLI (${bin})`,
        ...got,
        hint: `install ${bin}, or fix agent.command in ${cfg.configDir}/config.yaml`,
      });
    } else {
      checks.push({
        name: `${cfg.agent.provider} CLI`,
        ok: false,
        detail: "agent.command is not set",
        hint: `set agent.command in ${cfg.configDir}/config.yaml`,
      });
    }
  }

  // Credentials depend on which tracker this project drives.
  for (const name of REQUIRED_ENV[cfg.tracker.provider]) {
    checks.push({
      name,
      ok: !!process.env[name]?.trim(),
      detail: process.env[name]?.trim() ? "set" : "missing",
      hint: `add to ${cfg.configDir}/.env`,
    });
  }
  // Only meaningful for the built-in Claude adapter — other CLIs carry their
  // own auth and would show a permanently unset token here.
  if (cfg.agent.provider === "claude") {
    checks.push({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      ok: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      detail: process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "not set (will use cached login if present)",
      hint: "claude setup-token",
      soft: true,
    });
  }

  let allOk = true;
  for (const c of checks) {
    const hard = !c.soft;
    if (!c.ok && hard) allOk = false;
    if (quiet) {
      if (!c.ok && hard) logger.warn(`prereq missing: ${c.name} — ${c.detail} (${c.hint})`);
    } else {
      const mark = c.ok ? "✓" : c.soft ? "○" : "✗";
      const hintStr = !c.ok && c.hint ? `  → ${c.hint}` : "";
      console.log(`  ${mark} ${c.name.padEnd(24)} ${c.detail}${hintStr}`);
    }
  }
  if (!quiet) {
    console.log(allOk ? "\nAll prerequisites satisfied." : "\nMissing prerequisites above — fix the ✗ items.");
  }
  return allOk;
}
