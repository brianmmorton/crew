import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure `pattern` is present in the repo's root .gitignore. Idempotent.
 * Returns "added" if it wrote the line, "present" if it was already there.
 */
export function ensureGitignored(
  repoPath: string,
  pattern: string,
): "added" | "present" {
  const path = join(repoPath, ".gitignore");
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = content.split("\n").map((l) => l.trim());
  if (lines.includes(pattern)) return "present";
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  appendFileSync(path, `${prefix}${pattern}\n`);
  return "added";
}
