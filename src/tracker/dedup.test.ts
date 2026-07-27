import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle, similarity, isDuplicate } from "./dedup.js";

test("normalizeTitle lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(normalizeTitle("  Hello,   World!!  "), "hello world");
  assert.equal(normalizeTitle("Fix the Login-Bug (again)"), "fix the login bug again");
  assert.equal(normalizeTitle("A.B,C"), "a b c");
  assert.equal(normalizeTitle("   "), "");
});

test("similarity is 1 for identical titles", () => {
  assert.equal(similarity("Add dark mode toggle", "Add dark mode toggle"), 1);
  // identical up to punctuation/case/whitespace
  assert.equal(similarity("Add Dark Mode!", "add   dark mode"), 1);
});

test("similarity is 0 for disjoint titles", () => {
  assert.equal(similarity("apple banana", "carrot potato"), 0);
});

test("similarity is a fraction for partial overlap", () => {
  // tokens {a,b,c} vs {a,b,d}: intersection 2, union 4 => 0.5
  assert.equal(similarity("a b c", "a b d"), 0.5);
});

test("two empty titles count as identical", () => {
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("!!!", "   "), 1);
});

test("one empty title is not similar to a non-empty one", () => {
  assert.equal(similarity("", "something"), 0);
});

test("isDuplicate respects the threshold boundary", () => {
  // similarity of {a,b,c} vs {a,b,d} is exactly 0.5
  assert.equal(isDuplicate("a b c", "a b d", 0.5), true);
  assert.equal(isDuplicate("a b c", "a b d", 0.51), false);
  assert.equal(isDuplicate("a b c", "a b d", 0.49), true);

  assert.equal(isDuplicate("Login page crashes", "Login page crashes", 0.85), true);
  assert.equal(isDuplicate("apple", "orange", 0.85), false);
});
