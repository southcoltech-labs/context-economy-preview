// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitOf, must, showAt } from "./release-lib.mjs";
import { candidate } from "./promote.mjs";
import { changelogSection, releaseTarget, tagRelease } from "./tag-release.mjs";
import { bumpAndCommit, commitAll, fakeGh, fixtureRepo, PLUGINS, readJson, writeJson } from "./test-fixture.mjs";

const remoteTag = (fx, tag) => must(fx.run, "git", ["ls-remote", "origin", `refs/tags/${tag}^{}`]).split(/\s+/)[0];

test("first run tags the version commit, pushes the tag and creates the release", () => {
  const fx = fixtureRepo();
  writeFileSync(join(fx.root, "CHANGELOG.md"), "# fixture\n\n## 0.2.0\n\n### Minor Changes\n\n- new thing\n\n## 0.1.0\n\n- old\n");
  const sha = bumpAndCommit(fx, "0.2.0");
  const gh = fakeGh(fx.run);
  const r = tagRelease({ run: gh.run, root: fx.root });
  assert.deepEqual([r.tag, r.sha, r.tagged, r.released], ["v0.2.0", sha, "created", "created"]);
  assert.equal(remoteTag(fx, "v0.2.0"), sha);
  const create = gh.calls.find((a) => a[1] === "create");
  assert.ok(create.includes("--verify-tag"));
  // A candidate is a prerelease until promotion marks it latest.
  assert.ok(create.includes("--prerelease"));
  assert.deepEqual(gh.status.get("v0.2.0"), { prerelease: true, latest: false });
});

test("rerun after later merges tags nothing new and targets the same commit", () => {
  const fx = fixtureRepo();
  const sha = bumpAndCommit(fx, "0.2.0");
  const gh = fakeGh(fx.run);
  tagRelease({ run: gh.run, root: fx.root });
  writeFileSync(join(fx.root, "README.md"), "docs only\n");
  commitAll(fx.run, "docs");
  const r = tagRelease({ run: gh.run, root: fx.root });
  assert.deepEqual([r.sha, r.tagged, r.released], [sha, "skipped", "skipped"]);
});

test("a tag that exists at another commit fails and is not moved", () => {
  const fx = fixtureRepo();
  const other = commitAll(fx.run, "unrelated");
  must(fx.run, "git", ["tag", "-a", "v0.2.0", other, "-m", "squat"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/v0.2.0"]);
  bumpAndCommit(fx, "0.2.0");
  const gh = fakeGh(fx.run);
  assert.throws(() => tagRelease({ run: gh.run, root: fx.root }), /already exists at/);
  assert.equal(remoteTag(fx, "v0.2.0"), other);
  assert.equal(gh.calls.filter((a) => a[1] === "create").length, 0);
});

test("a missing release for an existing tag is created", () => {
  const fx = fixtureRepo();
  const sha = bumpAndCommit(fx, "0.2.0");
  must(fx.run, "git", ["tag", "-a", "v0.2.0", sha, "-m", "v0.2.0"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/v0.2.0"]);
  const r = tagRelease({ run: fakeGh(fx.run).run, root: fx.root });
  assert.deepEqual([r.tagged, r.released], ["skipped", "created"]);
});

test("a broken bump followed by a sync fix-up tags the fix-up, which promotion accepts", () => {
  const fx = fixtureRepo();
  writeJson(fx.root, "package.json", { ...readJson(fx.root, "package.json"), version: "0.2.0" });
  const broken = commitAll(fx.run, "bump without sync");
  const m = readJson(fx.root, ".claude-plugin/marketplace.json");
  m.metadata.version = "0.2.0";
  writeJson(fx.root, ".claude-plugin/marketplace.json", m);
  for (const name of PLUGINS) writeJson(fx.root, `plugins/${name}/.claude-plugin/plugin.json`, { name, version: "0.2.0" });
  const fixup = commitAll(fx.run, "sync manifests");
  const r = tagRelease({ run: fakeGh(fx.run).run });
  assert.equal(r.sha, fixup);
  assert.notEqual(r.sha, broken);
  assert.equal(remoteTag(fx, "v0.2.0"), fixup);
  assert.equal(candidate(fx.run, "v0.2.0").sha, fixup);
});

test("editing scripts.version after a release keeps the tag's identity", () => {
  const fx = fixtureRepo();
  const sha = bumpAndCommit(fx, "0.2.0");
  const gh = fakeGh(fx.run);
  tagRelease({ run: gh.run });
  const pkg = readJson(fx.root, "package.json");
  writeJson(fx.root, "package.json", { ...pkg, scripts: { version: "changeset version" } });
  commitAll(fx.run, "add scripts.version");
  writeJson(fx.root, "package.json", { ...pkg, scripts: { version: "changeset version && node sync.mjs" } });
  commitAll(fx.run, "change scripts.version");
  const r = tagRelease({ run: gh.run });
  assert.deepEqual([r.sha, r.tagged, r.released], [sha, "skipped", "skipped"]);
});

test("reformatting the version line after a release keeps the tag's identity", () => {
  const fx = fixtureRepo();
  const sha = bumpAndCommit(fx, "0.2.0");
  const gh = fakeGh(fx.run);
  tagRelease({ run: gh.run });
  writeFileSync(join(fx.root, "package.json"), JSON.stringify(readJson(fx.root, "package.json"), null, 4).replace('"version": "0.2.0"', '"version":"0.2.0"') + "\n");
  commitAll(fx.run, "reformat package.json");
  const r = tagRelease({ run: gh.run });
  assert.deepEqual([r.sha, r.tagged, r.released], [sha, "skipped", "skipped"]);
});

test("a tag already at a broken commit of the version is refused, not moved", () => {
  const fx = fixtureRepo();
  writeJson(fx.root, "package.json", { ...readJson(fx.root, "package.json"), version: "0.2.0" });
  const broken = commitAll(fx.run, "bump without sync");
  must(fx.run, "git", ["tag", "-a", "v0.2.0", broken, "-m", "v0.2.0"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/v0.2.0"]);
  bumpAndCommit(fx, "0.2.0");
  assert.throws(() => tagRelease({ run: fakeGh(fx.run).run }), /refusing to move it/);
  assert.equal(remoteTag(fx, "v0.2.0"), broken);
});

test("version drift blocks tagging", () => {
  const fx = fixtureRepo();
  writeJson(fx.root, "package.json", { ...readJson(fx.root, "package.json"), version: "0.2.0" });
  commitAll(fx.run, "bump without sync");
  assert.throws(() => tagRelease({ run: fakeGh(fx.run).run, root: fx.root }), /version drift/);
  assert.equal(commitOf(fx.run, "refs/tags/v0.2.0"), undefined);
});

test("changelogSection takes one version's section", () => {
  const text = "# x\n\n## 0.2.0\n\n- a\n- b\n\n## 0.1.0\n\n- c\n";
  assert.equal(changelogSection(text, "0.2.0"), "- a\n- b");
  assert.equal(changelogSection(text, "0.1.0"), "- c");
  assert.equal(changelogSection(text, "0.3.0"), undefined);
  assert.equal(changelogSection(undefined, "0.1.0"), undefined);
});

// The initial version boundary.

const remoteTagList = (fx) => must(fx.run, "git", ["ls-remote", "--tags", "origin"]);

test("at the 0.0.0 placeholder nothing is tagged, pushed or released", () => {
  const fx = fixtureRepo("0.0.0");
  const gh = fakeGh(fx.run);
  const r = tagRelease({ run: gh.run, root: fx.root });
  assert.deepEqual([r.placeholder, r.tagged, r.released, r.tag], [true, "skipped", "skipped", undefined]);
  assert.equal(remoteTagList(fx), "");
  assert.equal(must(fx.run, "git", ["tag", "--list"]), "");
  assert.deepEqual(gh.calls, []);
});

test("move (0.0.0) -> parity fixes -> version PR merge (0.1.0) -> later commit: the merge is the candidate and holds the parity work", () => {
  const fx = fixtureRepo("0.0.0");
  const move = must(fx.run, "git", ["rev-parse", "HEAD"]);
  // Parity work lands on main at the placeholder: tagging skips every one of these commits.
  writeFileSync(join(fx.root, "PARITY.md"), "reviewed Pi parity\n");
  const parity = commitAll(fx.run, "Pi parity");
  assert.equal(tagRelease({ run: fakeGh(fx.run).run, root: fx.root }).placeholder, true);
  // The changesets version PR: a branch commit that bumps everything, merged with a merge commit.
  must(fx.run, "git", ["checkout", "-q", "-b", "changeset-release/main"]);
  const branchBump = bumpAndCommit(fx, "0.1.0");
  must(fx.run, "git", ["checkout", "-q", "main"]);
  writeFileSync(join(fx.root, "NOTES.md"), "concurrent main work\n");
  commitAll(fx.run, "work on main during the PR");
  must(fx.run, "git", ["merge", "-q", "--no-ff", "-m", "Version Packages (#1)", "changeset-release/main"]);
  const merge = must(fx.run, "git", ["rev-parse", "HEAD"]);
  writeFileSync(join(fx.root, "LATER.md"), "after the release\n");
  commitAll(fx.run, "later");

  const target = releaseTarget(fx.run);
  assert.equal(target.version, "0.1.0");
  assert.equal(target.sha, merge);
  assert.notEqual(target.sha, branchBump);
  assert.notEqual(target.sha, move);
  assert.equal(showAt(fx.run, target.sha, "PARITY.md"), "reviewed Pi parity");
  assert.equal(run(fx, ["merge-base", "--is-ancestor", parity, target.sha]).code, 0);

  const gh = fakeGh(fx.run);
  const r = tagRelease({ run: gh.run, root: fx.root });
  assert.deepEqual([r.tag, r.sha, r.tagged, r.released], ["v0.1.0", merge, "created", "created"]);
  assert.equal(remoteTag(fx, "v0.1.0"), merge);
  assert.ok(!remoteTagList(fx).includes("v0.0.0"));
});

const run = (fx, args) => fx.run("git", args);
