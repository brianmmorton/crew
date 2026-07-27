import { spawn } from "node:child_process";
import type { CrewConfig, PersonaResult, RunPersonaOptions } from "../types.js";
import { detectUsageLimit, extractProposalsJson } from "../personas/parse.js";
import { register, unregister } from "./registry.js";
import { resolveResetAt, normalizeProposerResult } from "./shared.js";

type AgentCfg = CrewConfig["agent"];

/**
 * Run any coding-agent CLI configured in `agent` (Codex, Cursor, Grok, a local
 * script, …). crew stays provider-agnostic: it builds the command from config,
 * feeds it the prompt, streams stdout as activity, and treats the full stdout as
 * the result. Structured proposer output still works as long as the CLI prints
 * the JSON block; usage-limit back-off works if its output matches the patterns.
 */
export function runGeneric(agent: AgentCfg, opts: RunPersonaOptions): Promise<PersonaResult> {
  return new Promise<PersonaResult>((resolve) => {
    if (!agent.command) {
      resolve({
        summary: `agent.provider="${agent.provider}" but no agent.command is configured`,
        raw: "",
      });
      return;
    }

    const args = [...agent.args];
    if (agent.modelFlag && opts.model) args.push(agent.modelFlag, opts.model);
    if (agent.promptVia === "arg") args.push(opts.prompt);

    const child = spawn(agent.command, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    register(child);

    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line && opts.onActivity) opts.onActivity(line.slice(0, 160));
      }
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    const finish = (code: number | null): void => {
      unregister(child);
      const resultText = stdout;
      const usage = detectUsageLimit(`${resultText}\n${stderr}`);
      if (usage.limited) {
        resolve({ usageLimited: true, resetAt: resolveResetAt(usage.resetAt), raw: stdout });
        return;
      }
      const exitNote = code !== null && code !== 0 ? ` (agent exited ${code})` : "";
      if (opts.expectJson) {
        const normalized = normalizeProposerResult(extractProposalsJson(resultText));
        if (normalized) resolve({ ...normalized, raw: stdout });
        else resolve({ proposals: [], summary: `${resultText.slice(0, 500)}${exitNote}`, raw: stdout });
        return;
      }
      resolve({ summary: `${resultText.slice(0, 1000)}${exitNote}`, raw: stdout });
    };

    child.on("error", (e) => {
      unregister(child);
      stderr += `\n[spawn error] ${(e as Error).message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));

    if (agent.promptVia !== "arg") child.stdin.end(opts.prompt);
    else child.stdin.end();
  });
}
