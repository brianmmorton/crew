/**
 * `.crew/AGENTS.md` — crew's own reference doc (what crew is, the directory
 * layout, every `config.yaml` field), as opposed to `constitution.md`
 * (project-specific policy) and `personas/*.md` (project-specific prompts).
 *
 * Unlike those, this file is crew-owned: it should track the installed crew
 * version, not the user's edits, so `crew init`/`setup`/`doctor` regenerate it
 * whenever it's missing or stamped with an older version. The template says
 * "do not edit by hand" for exactly this reason — anything worth keeping
 * belongs in constitution.md instead.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_STAMP = /<!--\s*crew-generated:\s*v([^\s]+)/;

/** The version this AGENTS.md was generated for, or null if unstamped/absent. */
function stampedVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  const m = readFileSync(path, "utf8").match(VERSION_STAMP);
  return m ? m[1] : null;
}

/**
 * Compare two `x.y.z`-ish version strings. Returns negative/zero/positive
 * like `Array.prototype.sort`'s comparator. Non-numeric or missing segments
 * sort as 0, so "unknown" or a hand-truncated stamp never throws — it just
 * compares as very old, which triggers a (harmless) regeneration.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Write `.crew/AGENTS.md` from the template, stamped with `crewVersion`, if
 * it's missing or stamped with an older version than the one running now.
 * Returns true when it wrote (so callers can mention it), false when the
 * existing file was already current.
 */
export function refreshAgentsDoc(
  configDir: string,
  templatesDir: string,
  crewVersion: string,
): boolean {
  const dest = join(configDir, "AGENTS.md");
  const current = stampedVersion(dest);
  if (current && crewVersion !== "unknown" && compareVersions(current, crewVersion) >= 0) {
    return false;
  }
  const template = readFileSync(join(templatesDir, "AGENTS.md"), "utf8");
  writeFileSync(dest, template.replace("{{CREW_VERSION}}", crewVersion), "utf8");
  return true;
}
