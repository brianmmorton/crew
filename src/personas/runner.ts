import { spawn } from "node:child_process";
import type {
  PersonaPort,
  PersonaName,
  PersonaResult,
  Proposal,
  RunPersonaOptions,
} from "../types.js";
import {
  parseClaudeStdout,
  detectUsageLimit,
  extractProposalsJson,
} from "./parse.js";

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Resolve a raw reset-time string (e.g. "3:45pm" or "Mon 12:00am") to an ISO
 * 8601 instant relative to now. Returns the ISO string, or the raw input if it
 * can't be parsed. This is the ONE place a clock read is allowed (kept out of
 * the pure parse module).
 */
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
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0,
  );
  // If the time already passed today, assume it means the next occurrence.
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.toISOString();
}

export class PersonaRunner implements PersonaPort {
  private spawnClaude(
    args: string[],
    opts: RunPersonaOptions,
  ): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      // Force subscription billing: strip any API-key credentials from the
      // child's environment. Claude Code's precedence puts ANTHROPIC_API_KEY /
      // ANTHROPIC_AUTH_TOKEN above the subscription, and in headless (-p) mode
      // the API key is ALWAYS used when present — which would silently bill
      // pay-as-you-go credits. Removing them here lets you keep the key set for
      // other tools (e.g. Task Master) while crew always uses your subscription
      // (via CLAUDE_CODE_OAUTH_TOKEN or cached OAuth login).
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const child = spawn("claude", args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdout += d;
      });
      child.stderr.on("data", (d: string) => {
        stderr += d;
      });

      child.on("error", (err) => {
        // Spawn failure (e.g. claude not found): surface via stderr.
        stderr += `\n[spawn error] ${(err as Error).message}`;
        resolve({ stdout, stderr, code: null });
      });
      child.on("close", (code) => {
        resolve({ stdout, stderr, code });
      });

      // Pipe the prompt to stdin and close it.
      child.stdin.end(opts.prompt);
    });
  }

  async run(
    _name: PersonaName,
    opts: RunPersonaOptions,
  ): Promise<PersonaResult> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ];
    if (opts.model) {
      args.push("--model", opts.model);
    }

    const { stdout, stderr, code } = await this.spawnClaude(args, opts);
    const parsed = parseClaudeStdout(stdout);
    const resultText = parsed.resultText;

    // Usage-limit detection runs over both the parsed result and raw stderr.
    const usage = detectUsageLimit(`${resultText}\n${stderr}`);
    if (usage.limited) {
      return {
        usageLimited: true,
        resetAt: resolveResetAt(usage.resetAt),
        raw: stdout,
      };
    }

    const exitNote =
      code !== null && code !== 0 ? ` (claude exited with code ${code})` : "";

    if (opts.expectJson) {
      const extracted = extractProposalsJson(resultText);
      const normalized = normalizeProposerResult(extracted);
      if (normalized) {
        return { ...normalized, raw: stdout };
      }
      return {
        proposals: [],
        summary: `${resultText.slice(0, 500)}${exitNote}`,
        raw: stdout,
      };
    }

    // Implementer: the engine derives `committed` from git, not from us.
    return {
      summary: `${resultText.slice(0, 1000)}${exitNote}`,
      raw: stdout,
    };
  }
}

/**
 * Normalize a parsed proposer payload into the PersonaResult shape. Accepts
 * either a bare array of proposals, or an object like
 * `{ proposals: [...], friction: [...], summary }`. Returns null if the input
 * isn't a usable shape.
 */
function normalizeProposerResult(
  value: unknown,
): Pick<PersonaResult, "proposals" | "friction" | "summary"> | null {
  if (Array.isArray(value)) {
    return { proposals: value as Proposal[] };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Pick<PersonaResult, "proposals" | "friction" | "summary"> = {};
    if (Array.isArray(obj.proposals)) {
      out.proposals = obj.proposals as Proposal[];
    }
    if (Array.isArray(obj.friction)) {
      out.friction = obj.friction as Proposal[];
    }
    if (typeof obj.summary === "string") {
      out.summary = obj.summary;
    }
    // Only treat it as a valid proposer object if it carried at least one
    // recognized field.
    if ("proposals" in out || "friction" in out || "summary" in out) {
      return out;
    }
  }
  return null;
}
