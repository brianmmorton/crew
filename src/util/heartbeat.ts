import type { Logger } from "../types.js";

/**
 * Run `fn`, emitting a heartbeat log line every `intervalMs` while it's in
 * flight, so long silent operations (a headless Claude run that takes a minute)
 * show visible progress. Always clears the timer when done.
 */
export async function withHeartbeat<T>(
  logger: Logger,
  label: string,
  fn: () => Promise<T>,
  intervalMs = 20_000,
): Promise<T> {
  const start = Date.now();
  const iv = setInterval(() => {
    logger.info(`${label}: still working (${Math.round((Date.now() - start) / 1000)}s)…`);
  }, intervalMs);
  if (typeof iv.unref === "function") iv.unref();
  try {
    return await fn();
  } finally {
    clearInterval(iv);
  }
}
