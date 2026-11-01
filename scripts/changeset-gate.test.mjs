// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, changesetGate } from "./changeset-gate.mjs";
import { must } from "./release-lib.mjs";
import { commitAll, fixtureRepo } from "./test-fixture.mjs";

const pr = (files, labels = [], extra = {}) => changesetGate({ files, labels, headRef: "feat", headRepo: "o/r", repo: "o/r", ...extra });

test("docs-only plus no-release is exempt", () => {
  assert.equal(pr(["docs/design/x.md", "README.md", ".changeset/README.md"], ["no-release"]).exempt, true);
});

test("the root LICENSE and NOTICE are docs; a nested one is not", () => {
  assert.equal(pr(["LICENSE", "NOTICE"], ["no-release"]).exempt, true);
  for (const f of ["plugins/tool-gateway/NOTICE", "extensions/tool-gateway/LICENSE"]) {
    assert.equal(pr([f], ["no-release"]).exempt, false, f);
  }
});

test("runtime plus no-release still needs a changeset", () => {
  const g = pr(["docs/a.md", "plugins/tool-gateway/hooks/register.tsx"], ["no-release"]);
  assert.equal(g.exempt, false);
  assert.match(g.reason, /register\.tsx/);
});

test("plugin Markdown (commands, skills, READMEs) is not docs", () => {
  for (const f of ["plugins/second-plugin/commands/recall.md", "plugins/third-plugin/README.md", "extensions/x/SKILL.md"]) {
    assert.equal(pr([f], ["no-release"]).exempt, false, f);
  }
});

test("workflows, scripts, manifests and package files are not docs", () => {
  for (const f of [".github/workflows/ci.yml", "scripts/promote.mjs", ".claude-plugin/marketplace.json", "package.json", ".gitleaks.toml"]) {
    assert.equal(pr([f], ["no-release"]).exempt, false, f);
  }
});

test("ordinary runtime or docs changes without the label need a changeset", () => {
  assert.equal(pr(["plugins/tool-gateway/hooks/register.tsx"]).exempt, false);
  assert.equal(pr(["docs/a.md"]).exempt, false);
});

test("an empty diff with the label is not exempt", () => {
  assert.equal(pr([], ["no-release"]).exempt, false);
});

test("the version PR is exempt only from this repository", () => {
  const files = ["package.json", "CHANGELOG.md"];
  assert.equal(pr(files, [], { headRef: "changeset-release/main" }).exempt, true);
  assert.equal(pr(files, [], { headRef: "changeset-release/main", headRepo: "fork/r" }).exempt, false);
  assert.equal(pr(files, [], { headRef: "changeset-release/main", headRepo: undefined }).exempt, false);
});

test("changedFiles lists the branch's changes against its merge base", () => {
  const fx = fixtureRepo();
  must(fx.run, "git", ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(fx.root, "NOTES.md"), "n\n");
  commitAll(fx.run, "notes");
  assert.deepEqual(changedFiles(fx.run, "main"), ["NOTES.md"]);
});

test("moving a runtime file into docs/ with no-release is not exempt (real git)", () => {
  const fx = fixtureRepo();
  const runtime = "plugins/tool-gateway/hooks/tool.ts";
  mkdirSync(join(fx.root, "plugins/tool-gateway/hooks"), { recursive: true });
  writeFileSync(join(fx.root, runtime), "export const tool = 1;\n".repeat(20));
  commitAll(fx.run, "runtime file");
  must(fx.run, "git", ["push", "-q", "origin", "main"]);
  must(fx.run, "git", ["checkout", "-q", "-b", "move"]);
  mkdirSync(join(fx.root, "docs"), { recursive: true });
  must(fx.run, "git", ["mv", runtime, "docs/tool.md"]);
  commitAll(fx.run, "move to docs");
  const files = changedFiles(fx.run, "main");
  assert.deepEqual([...files].sort(), ["docs/tool.md", "plugins/tool-gateway/hooks/tool.ts"]);
  const g = changesetGate({ files, labels: ["no-release"], headRef: "move", headRepo: "o/r", repo: "o/r" });
  assert.equal(g.exempt, false);
  assert.match(g.reason, /hooks\/tool\.ts/);
});

test("a rename within docs/ with no-release stays exempt (real git)", () => {
  const fx = fixtureRepo();
  mkdirSync(join(fx.root, "docs"), { recursive: true });
  writeFileSync(join(fx.root, "docs/a.md"), "notes\n".repeat(20));
  commitAll(fx.run, "doc");
  must(fx.run, "git", ["checkout", "-q", "-b", "rename"]);
  must(fx.run, "git", ["mv", "docs/a.md", "docs/b.md"]);
  commitAll(fx.run, "rename doc");
  const files = changedFiles(fx.run, "main");
  assert.deepEqual([...files].sort(), ["docs/a.md", "docs/b.md"]);
  assert.equal(changesetGate({ files, labels: ["no-release"], headRef: "rename", headRepo: "o/r", repo: "o/r" }).exempt, true);
});
