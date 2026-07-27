import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persist one agent run's full output to its own file under
 * <configDir>/logs/runs/<timestamp>-<label>.log, so you can inspect exactly what
 * a given QA/Design/Architect/Implementer run produced. Returns the path (or null).
 */
export function writeRunLog(configDir: string, label: string, content: string): string | null {
  try {
    const dir = join(configDir, "logs", "runs");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = join(dir, `${ts}-${safe}.log`);
    writeFileSync(path, content || "(no output captured)");
    return path;
  } catch {
    return null;
  }
}
