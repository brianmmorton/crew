import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setColorEnabled } from "./color.js";
import { logger, logToFile } from "./logger.js";

/**
 * The contract: the terminal may get escape codes, the log file never does.
 * People grep that file and paste it into issues, so a stray \x1b there is a
 * real bug — not a cosmetic one.
 */

/** Capture stderr for the duration of `fn`. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // console.error goes through process.stderr.write.
  process.stderr.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === "string" ? c : Buffer.from(c).toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("the file sink receives no escape codes even when colors are on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-log-"));
  const path = join(dir, "crew.log");
  logToFile(path);
  setColorEnabled(true);

  const out = captureStderr(() => {
    logger.warn("ABC-1: verify gate failed", { error: "boom" });
  });

  // Give the write stream a tick to flush.
  await new Promise((r) => setTimeout(r, 50));
  const onDisk = readFileSync(path, "utf8");

  assert.ok(out.includes("\x1b["), "terminal copy should be colored");
  assert.ok(!onDisk.includes("\x1b["), "file copy must be plain");
  assert.match(onDisk, /WARN.*ABC-1: verify gate failed/);
  assert.match(onDisk, /"error":"boom"/);
});

test("a path containing an issue key is painted as one unit, not split", () => {
  setColorEnabled(true);
  const out = captureStderr(() => {
    logger.warn("ABC-1: full verify output → /repo/.crew/logs/runs/verify-ABC-1-FAILED.log");
  });
  // The key regex must not fire inside the filename — that would break the
  // path into differently-colored fragments and make it unreadable.
  assert.ok(
    out.includes("/repo/.crew/logs/runs/verify-ABC-1-FAILED.log\x1b["),
    "the path must be a single uninterrupted span",
  );
});

test("trailing punctuation stays outside the colored path", () => {
  setColorEnabled(true);
  const out = captureStderr(() => {
    logger.info("verify gate passed (output → /tmp/a/b.log)");
  });
  assert.ok(out.includes("b.log\x1b[0m)"), "the closing paren must not be colored");
});

test("coloring never alters the underlying text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-log-"));
  const path = join(dir, "crew.log");
  logToFile(path);

  const msg = "implementer ABC-42: verify gate failed — returning to \"Backlog\"";
  setColorEnabled(true);
  logger.warn(msg);
  setColorEnabled(false);
  logger.warn(msg);

  await new Promise((r) => setTimeout(r, 50));
  const lines = readFileSync(path, "utf8").trim().split("\n");
  // Same message logged with colors on and off must produce identical file
  // output once the timestamp is removed.
  const body = (l: string) => l.slice(l.indexOf(" ") + 1);
  assert.equal(body(lines[0]), body(lines[1]));
});
