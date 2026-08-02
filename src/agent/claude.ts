import { spawn } from "node:child_process";
import type { PersonaResult, RunPersonaOptions } from "../types.js";
import { detectUsageLimit, extractProposalsJson } from "../personas/parse.js";
import { register, unregister } from "./registry.js";
import { resolveResetAt, normalizeProposerResult } from "./shared.js";

/** Compact one-line summary of a Claude stream event, or null to skip it. */
function summarizeEvent(ev: Record<string, unknown>): string | null {
  const type = ev.type as string | undefined;
  if (type === "assistant") {
    const msg = ev.message as { content?: unknown[] } | undefined;
    const parts: string[] = [];
    for (const c of msg?.content ?? []) {
      const item = c as { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
      if (item.type === "tool_use") parts.push(`→ ${item.name}${briefInput(item.input)}`);
      else if (item.type === "text" && item.text?.trim()) {
        const first = item.text.trim().split("\n")[0].slice(0, 100);
        if (first) parts.push(`· ${first}`);
      }
    }
    return parts.length ? parts.join("  ") : null;
  }
  if (type === "result") {
    const err = ev.is_error ? " (error)" : "";
    const cost = typeof ev.total_cost_usd === "number" ? ` $${(ev.total_cost_usd as number).toFixed(2)}` : "";
    return `done${err}${cost}`;
  }
  return null;
}

function briefInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = (k: string): string | null => (typeof input[k] === "string" ? (input[k] as string) : null);
  const v = pick("command") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ?? pick("description");
  return v ? ` ${v.replace(/\s+/g, " ").slice(0, 90)}` : "";
}

/** Run Claude Code headless with streaming output (live activity + kill support). */
export function runClaude(opts: RunPersonaOptions): Promise<PersonaResult> {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
  if (opts.model) args.push("--model", opts.model);
  // Per-persona tooling. `--strict-mcp-config` is the important half: without it
  // the run would also inherit whatever servers the user has configured
  // globally, and a persona's tools would stop being reproducible across
  // machines. Passed unconditionally so a persona granted nothing gets nothing.
  //
  // Note there is deliberately no `--allowedTools` here: it is ignored under
  // `--dangerously-skip-permissions` (above), which headless runs require. A
  // server's `allowedTools` is injected into the prompt by the runner instead.
  // `--disallowedTools` is different: it removes the tool from the agent
  // entirely, and that DOES hold under skip-permissions (verified) — which is
  // what makes read-only personas enforceable rather than merely requested.
  args.push("--strict-mcp-config");
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.disallowedTools?.length) {
    args.push("--disallowedTools", opts.disallowedTools.join(","));
  }

  return new Promise<PersonaResult>((resolve) => {
    // Force subscription billing: strip API-key creds from the child env.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const child = spawn("claude", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env });
    register(child);

    const events: Record<string, unknown>[] = [];
    let rawStdout = "";
    let stderr = "";
    let buf = "";

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      rawStdout += line + "\n";
      let ev: Record<string, unknown> | null = null;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      events.push(ev);
      if (opts.onActivity) {
        const s = summarizeEvent(ev);
        if (s) opts.onActivity(s);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    const finish = (code: number | null): void => {
      unregister(child);
      if (buf.trim()) handleLine(buf);

      let resultText = "";
      let isError = false;
      for (const ev of events) {
        if (ev.type === "result") {
          resultText = typeof ev.result === "string" ? (ev.result as string) : "";
          isError = !!ev.is_error;
        }
      }

      const usage = detectUsageLimit(`${resultText}\n${stderr}`);
      if (usage.limited) {
        resolve({ usageLimited: true, resetAt: resolveResetAt(usage.resetAt), raw: rawStdout });
        return;
      }
      const exitNote =
        code !== null && code !== 0 ? ` (claude exited ${code}${isError ? ", is_error" : ""})` : "";

      if (opts.expectJson) {
        const normalized = normalizeProposerResult(extractProposalsJson(resultText));
        if (normalized) resolve({ ...normalized, raw: rawStdout });
        else resolve({ proposals: [], summary: `${resultText.slice(0, 500)}${exitNote}`, raw: rawStdout });
        return;
      }
      resolve({ summary: `${resultText.slice(0, 1000)}${exitNote}`, raw: rawStdout });
    };

    child.on("error", (e) => {
      unregister(child);
      stderr += `\n[spawn error] ${(e as Error).message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.end(opts.prompt);
  });
}
