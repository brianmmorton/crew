import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, matchesAny } from "./glob.js";

test("single * does not cross a slash", () => {
  const re = globToRegExp("apps/*/index.ts");
  assert.equal(re.test("apps/api/index.ts"), true);
  assert.equal(re.test("apps/api/nested/index.ts"), false);
});

test("** crosses slashes", () => {
  const re = globToRegExp("apps/**/index.ts");
  assert.equal(re.test("apps/api/index.ts"), true);
  assert.equal(re.test("apps/api/nested/deep/index.ts"), true);
});

test("? matches exactly one non-slash char", () => {
  const re = globToRegExp("file?.ts");
  assert.equal(re.test("file1.ts"), true);
  assert.equal(re.test("file.ts"), false);
  assert.equal(re.test("fil/.ts"), false);
});

test(".env* catches a nested basename via matchesAny", () => {
  assert.equal(matchesAny("apps/api/.env.local", [".env*"]), true);
});

test("**/migrations/** catches a nested migration file", () => {
  assert.equal(
    matchesAny("apps/api/prisma/migrations/x.sql", ["**/migrations/**"]),
    true,
  );
});

test("a non-match returns false", () => {
  assert.equal(
    matchesAny("src/index.ts", [".env*", "**/migrations/**", ".github/**"]),
    false,
  );
});
