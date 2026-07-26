import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../types.js";

function fmt(level: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const extra = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return `${ts} ${level} ${msg}${extra}`;
}

let sink: WriteStream | null = null;

/** Also append log lines to a file (in addition to stderr). Best-effort. */
export function logToFile(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    sink = createWriteStream(filePath, { flags: "a" });
  } catch {
    /* file logging is best-effort; stderr still works */
  }
}

/** Log file inside the project's crew dir: <configDir>/logs/crew.log (override CREW_LOG_DIR). */
export function logFilePath(configDir: string): string {
  const dir = process.env.CREW_LOG_DIR?.trim() || join(configDir, "logs");
  return join(dir, "crew.log");
}

function emit(level: string, msg: string, meta?: Record<string, unknown>): void {
  const line = fmt(level, msg, meta);
  console.error(line);
  sink?.write(line + "\n");
}

/** stderr logger that optionally mirrors to a file (see logToFile). */
export const logger: Logger = {
  info: (m, meta) => emit("INFO ", m, meta),
  warn: (m, meta) => emit("WARN ", m, meta),
  error: (m, meta) => emit("ERROR", m, meta),
};
