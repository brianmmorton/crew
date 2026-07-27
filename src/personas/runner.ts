import { spawn, type ChildProcess } from "node:child_process";
import type {
  PersonaPort,
  PersonaName,
  PersonaResult,
  Proposal,
  RunPersonaOptions,
} from "../types.js";
import { detectUsageLimit, extractProposalsJson } from "./parse.js";

// Registry of live claude child processes, so a hotkey can kill the active run.
const active = new Set<ChildProcess>();

/** Kill all in-flight agent runs. Returns how many were signalled. */
export function killActiveRuns(): number {
  let n = 0;
  for (const c of active) {
    try {
      c.kill("SIGTERM");
      n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}

interface StreamOutcome {
  events: Record<string, unknown>[];
  rawStdout: string;
  stderr: string;
  code: number | null;
}

/** Resolve "3:45pm" to an ISO instant (the one spot that reads the clock). */
function resolveResetAt(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return raw;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && hour !== 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.toISOString();
}

/** Compact one-line summary of a stream event, or null to skip it. */
function summarizeEvent(ev: Record<string, unknown>): string | null {
  const type = ev.type as string | undefined;
  if (type === "assistant") {
    const msg = ev.message as { content?: unknown[] } | undefined;
    const parts: string[] = [];
    for (const c of msg?.content ?? []) {
      const item = c as { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
      if (item.type === "tool_use") {
        parts.push(`→ ${item.name}${briefInput(item.name, item.input)}`);
      } else if (item.type === "text" && item.text?.trim()) {
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

function briefInput(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = (k: string): string | null => (typeof input[k] === "string" ? (input[k] as string) : null);
  const v =
    pick("command") ?? pick("file_path") ?? pick("path") ?? pick("pattern") ?? pick("description");
  return v ? ` ${v.replace(/\s+/g, " ").slice(0, 90)}` : "";
}

export class PersonaRunner implements PersonaPort {
  private spawnClaude(args: string[], opts: RunPersonaOptions): Promise<StreamOutcome> {
    return new Promise<StreamOutcome>((resolve) => {
      // Force subscription billing: strip API-key creds from the child env.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const child = spawn("claude", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env });
      active.add(child);

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
          return; // non-JSON noise
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

      child.on("error", (err) => {
        active.delete(child);
        stderr += `\n[spawn error] ${(err as Error).message}`;
        resolve({ events, rawStdout, stderr, code: null });
      });
      child.on("close", (code) => {
        active.delete(child);
        if (buf.trim()) handleLine(buf);
        resolve({ events, rawStdout, stderr, code });
      });

      child.stdin.end(opts.prompt);
    });
  }

  async run(_name: PersonaName, opts: RunPersonaOptions): Promise<PersonaResult> {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (opts.model) args.push("--model", opts.model);

    const { events, rawStdout, stderr, code } = await this.spawnClaude(args, opts);

    // The final "result" event carries the response text + error flag.
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
      return { usageLimited: true, resetAt: resolveResetAt(usage.resetAt), raw: rawStdout };
    }

    const exitNote =
      code !== null && code !== 0 ? ` (claude exited with code ${code}${isError ? ", is_error" : ""})` : "";

    if (opts.expectJson) {
      const extracted = extractProposalsJson(resultText);
      const normalized = normalizeProposerResult(extracted);
      if (normalized) return { ...normalized, raw: rawStdout };
      return { proposals: [], summary: `${resultText.slice(0, 500)}${exitNote}`, raw: rawStdout };
    }

    return { summary: `${resultText.slice(0, 1000)}${exitNote}`, raw: rawStdout };
  }
}

function normalizeProposerResult(
  value: unknown,
): Pick<PersonaResult, "proposals" | "friction" | "summary"> | null {
  if (Array.isArray(value)) return { proposals: value as Proposal[] };
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Pick<PersonaResult, "proposals" | "friction" | "summary"> = {};
    if (Array.isArray(obj.proposals)) out.proposals = obj.proposals as Proposal[];
    if (Array.isArray(obj.friction)) out.friction = obj.friction as Proposal[];
    if (typeof obj.summary === "string") out.summary = obj.summary;
    if ("proposals" in out || "friction" in out || "summary" in out) return out;
  }
  return null;
}
