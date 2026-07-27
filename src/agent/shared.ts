import type { PersonaResult, Proposal } from "../types.js";

/** Resolve "3:45pm" to an ISO instant (the one place a clock read is allowed). */
export function resolveResetAt(raw: string | null): string | null {
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

/** Normalize a parsed proposer payload (array or {proposals,friction,summary}). */
export function normalizeProposerResult(
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
