// SPDX-License-Identifier: Apache-2.0

// The repo's gitleaks config must scan the published tree clean and still catch a real-looking
// secret planted in it (CI, gitleaks). tool-gateway has no
// synthetic-secret fixtures, so the subject is a copy of every tracked file plus a generated file
// of secret-like but non-matching text. Skipped where gitleaks is not installed.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeRunner, must } from "./release-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANTED_SOURCE = "plugins/tool-gateway/hooks/ledger.test.ts";
const GENERATED = "secret-like.txt";
const hasGitleaks = makeRunner(ROOT)("gitleaks", ["version"]).code === 0;

/** Words that look like secrets to a reader, with values no default rule should match. */
const SECRET_LIKE = [
  "password = changeme",
  "token: none",
  "api_key=REPLACE_ME",
  'export GITHUB_TOKEN=""',
  "Authorization: Bearer <token>",
].join("\n") + "\n";

/** The tracked tree copied as committed, plus the generated file; `plant` adds a token to two files. */
function scan(plant) {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-"));
  const files = must(makeRunner(ROOT), "git", ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const rel of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  writeFileSync(join(dir, GENERATED), SECRET_LIKE);
  if (plant) for (const rel of [GENERATED, PLANTED_SOURCE]) appendFileSync(join(dir, rel), `\nexport const leaked = "${plant()}";\n`);
  return makeRunner(dir)("gitleaks", ["dir", "--no-banner", "--redact", "--config", join(ROOT, ".gitleaks.toml"), dir]);
}

test("the source file the plant goes into exists", () => {
  assert.ok(existsSync(join(ROOT, PLANTED_SOURCE)), PLANTED_SOURCE);
});

// Built at run time so the source never holds a token-shaped string.
const fakeGithubToken = () => "ghp" + "_" + randomBytes(27).toString("base64").replace(/[^0-9A-Za-z]/g, "x").slice(0, 36);

test("the published tree and the secret-like file scan clean as committed", { skip: !hasGitleaks && "gitleaks not installed" }, () => {
  const r = scan();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test("a real-looking token planted in each of two files is still detected", { skip: !hasGitleaks && "gitleaks not installed" }, () => {
  const r = scan(fakeGithubToken);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /leaks found: 2/);
});
