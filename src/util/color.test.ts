import { test } from "node:test";
import assert from "node:assert/strict";
import { colorEnabled, setColorEnabled, stripAnsi, style } from "./color.js";

/**
 * The load-bearing property here is that colors are cosmetic: stripping the
 * escapes must always give back the exact original text, because that stripped
 * copy is what lands in the log file.
 */

test("style wraps text in an escape sequence when enabled", () => {
  setColorEnabled(true);
  const out = style("hello", "red");
  assert.match(out, /^\x1b\[31mhello\x1b\[0m$/);
});

test("style is a no-op when colors are disabled", () => {
  setColorEnabled(false);
  assert.equal(style("hello", "red", "bold"), "hello");
});

test("multiple styles stack into one opening sequence", () => {
  setColorEnabled(true);
  assert.equal(style("x", "yellow", "bold"), "\x1b[33m\x1b[1mx\x1b[0m");
});

test("styling an empty string adds nothing", () => {
  setColorEnabled(true);
  assert.equal(style("", "red"), "");
});

test("stripAnsi is an exact inverse of style", () => {
  setColorEnabled(true);
  for (const s of ["ABC-1", "verify failed", "https://pr/1", "a │ b"]) {
    assert.equal(stripAnsi(style(s, "cyan", "bold")), s);
  }
});

test("stripAnsi leaves uncolored text untouched", () => {
  assert.equal(stripAnsi("plain text"), "plain text");
});

test("setColorEnabled round-trips", () => {
  setColorEnabled(true);
  assert.equal(colorEnabled(), true);
  setColorEnabled(false);
  assert.equal(colorEnabled(), false);
});
