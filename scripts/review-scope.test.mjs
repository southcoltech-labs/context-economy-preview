// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changes, main, reviewScope, SECTIONS, summary } from "./review-scope.mjs";
import { must } from "./release-lib.mjs";
import { commitAll, fixtureRepo } from "./test-fixture.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "review-scope.mjs");
const REVIEWING = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "REVIEWING.md"), "utf8");
const scope = (paths, headRef = "feat") => reviewScope({ changes: paths.map((p) => ["M", p]), headRef }).sections;

test("every section the scope can name is a heading in REVIEWING.md", () => {
  const headings = new Set([...REVIEWING.matchAll(/^## (.+)$/gm)].map(([, h]) => h));
  for (const name of ["All pull requests", ...SECTIONS.map(([n]) => n), "The version pull request"]) {
    assert.ok(headings.has(name), name);
  }
});

test("every pull request gets the general section; docs alone add nothing else", () => {
  assert.deepEqual(scope([]), ["All pull requests"]);
  assert.deepEqual(scope(["README.md", "docs/MAINTAINER-SETUP.md"]), ["All pull requests"]);
});

test("the checks and their review rules are their own section, not release tooling", () => {
  for (const p of ["scripts/signoff-gate.mjs", "scripts/changeset-gate.test.mjs", "scripts/workflow-policy.test.mjs", "scripts/workflow-policy.mjs",
    ".github/CODEOWNERS", ".github/pull_request_template.md", "docs/REVIEWING.md"]) {
    assert.deepEqual(scope([p]), ["All pull requests", "Checks and review rules"], p);
  }
  assert.deepEqual(scope(["scripts/promote.mjs"]), ["All pull requests", "Release tooling"]);
});

test("each path family maps to its section, in the document's order", () => {
  assert.deepEqual(
    scope(["plugins/tool-gateway/hooks/register.tsx", ".github/workflows/ci.yml", "package-lock.json", "NOTICE",
      ".gitleaks.toml", "plugins/tool-gateway/.claude-plugin/plugin.json"]),
    ["All pull requests", "Workflows", "Dependencies", "Repository configuration", "Runtime", "Legal and security documents"],
  );
});

test("the version PR adds its section", () => {
  assert.deepEqual(scope(["package.json"], "changeset-release/main"), ["All pull requests", "Dependencies", "The version pull request"]);
});

test("deleted test files are listed; changed or added ones are not", () => {
  const r = reviewScope({
    changes: [["D", "scripts/promote.test.mjs"], ["M", "scripts/tag-release.test.mjs"], ["D", "docs/a.md"], ["D", "x/test_store.py"]],
    headRef: "feat",
  });
  assert.deepEqual(r.deletedTests, ["scripts/promote.test.mjs", "x/test_store.py"]);
  assert.match(summary(r, 4), /\*\*Deleted test files:\*\*\n\n- `scripts\/promote\.test\.mjs`\n- `x\/test_store\.py`\n$/);
});

test("summary is a checklist of the sections", () => {
  assert.equal(
    summary({ sections: ["All pull requests", "Runtime"], deletedTests: [] }, 3),
    "## Review scope\n\n3 changed paths. Sections of [docs/REVIEWING.md](docs/REVIEWING.md) to go through:\n\n- [ ] All pull requests\n- [ ] Runtime\n",
  );
});

test("changes reads statuses against the merge base; a move is a delete and an add (real git)", () => {
  const fx = fixtureRepo();
  writeFileSync(join(fx.root, "a.test.mjs"), "x\n".repeat(20));
  commitAll(fx.run, "test");
  must(fx.run, "git", ["checkout", "-q", "-b", "feat"]);
  must(fx.run, "git", ["mv", "a.test.mjs", "b.md"]);
  commitAll(fx.run, "move");
  assert.deepEqual(changes(fx.run, "main").sort(), [["A", "b.md"], ["D", "a.test.mjs"]]);
});

test("main writes the summary to stdout and the run summary (real git)", () => {
  const fx = fixtureRepo();
  must(fx.run, "git", ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(fx.root, "NOTICE"), "n\n");
  commitAll(fx.run, "notice");
  must(fx.run, "git", ["update-ref", "refs/remotes/origin/main", "main"]);
  const file = join(fx.base, "summary.md");
  let printed = "";
  assert.equal(main({ BASE_REF: "main", HEAD_REF: "feat", GITHUB_STEP_SUMMARY: file }, fx.run, (t) => { printed += t; }), 0);
  assert.match(printed, /- \[ \] Legal and security documents\n$/);
  assert.equal(readFileSync(file, "utf8"), printed);
});

test("main still succeeds when the base cannot be resolved (real git)", () => {
  const fx = fixtureRepo();
  let printed = "";
  assert.equal(main({ BASE_REF: "no-such-branch", HEAD_REF: "feat" }, fx.run, (t) => { printed += t; }), 0);
  assert.match(printed, /^## Review scope\n\nUnavailable: git diff .*\. Go through every section/);
});

test("main still succeeds when the run summary cannot be written", () => {
  const fx = fixtureRepo();
  must(fx.run, "git", ["update-ref", "refs/remotes/origin/main", "main"]);
  const dir = join(fx.base, "a-directory");
  mkdirSync(dir);
  let printed = "";
  assert.equal(main({ BASE_REF: "main", HEAD_REF: "feat", GITHUB_STEP_SUMMARY: dir }, fx.run, (t) => { printed += t; }), 0);
  assert.match(printed, /- \[ \] All pull requests\n/);
  assert.match(printed, /could not write the run summary: EISDIR/);
});

test("the CLI exits 0 when git fails", () => {
  const fx = fixtureRepo();
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: fx.root, env: { ...fx.env, BASE_REF: "no-such-branch" }, encoding: "utf8" });
  assert.match(out, /Unavailable: git diff/);
});
