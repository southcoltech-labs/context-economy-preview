// SPDX-License-Identifier: Apache-2.0

// release-plan.mjs decides from the release state, mirrors the pinned changesets/action, and
// fails instead of answering "nothing to do" when it cannot read the state.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { must } from "./release-lib.mjs";
import { changesetReleases, exists, pendingChangesets, planFor, releasePlan } from "./release-plan.mjs";
import { tagRelease } from "./tag-release.mjs";
import { bumpAndCommit, fakeGh, fixtureRepo } from "./test-fixture.mjs";

const REPO = "o/r";
const NONE = { total: 0, releasing: 0 };
const never = () => assert.fail("no API call expected");
const plan = (over) => releasePlan({ changesets: NONE, version: "0.2.0", tagExists: never, releaseExists: never, ...over });

const CHANGESET = '---\n"context-economy": minor\n---\n\nNew thing.\n';
const EMPTY = "---\n---\n";

function changesetDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "release-plan-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("a pending changeset that releases something runs, even at the placeholder version", () => {
  const r = plan({ changesets: { total: 1, releasing: 1 }, version: "0.0.0" });
  assert.equal(r.run, true);
  assert.match(r.reason, /version PR/);
});

test("a pending changeset runs even when the current version is tagged and released", () => {
  assert.equal(plan({ changesets: { total: 2, releasing: 1 }, tagExists: () => true, releaseExists: () => true }).run, true);
});

test("pending changesets that are all empty do nothing, even with an untagged version", () => {
  const r = plan({ changesets: { total: 2, releasing: 0 }, tagExists: () => false });
  assert.equal(r.run, false);
  assert.match(r.reason, /all empty/);
});

test("the placeholder version with no changesets does nothing and asks no API", () => {
  assert.equal(plan({ version: "0.0.0" }).run, false);
});

test("a version without its tag runs", () => {
  const r = plan({ tagExists: () => false });
  assert.equal(r.run, true);
  assert.match(r.reason, /v0\.2\.0 is not tagged/);
});

test("a tag without its GitHub release runs, to repair the release", () => {
  const r = plan({ tagExists: () => true, releaseExists: () => false });
  assert.equal(r.run, true);
  assert.match(r.reason, /no GitHub release: repair/);
});

test("a tag with its release does nothing", () => {
  assert.equal(plan({ tagExists: () => true, releaseExists: () => true }).run, false);
});

test("a version that is not x.y.z fails", () => {
  assert.throws(() => plan({ version: "0.2" }), /not x\.y\.z/);
});

test("a failed state read fails; it is never read as nothing to do", () => {
  const boom = () => { throw new Error("gh api failed"); };
  assert.throws(() => plan({ tagExists: boom }), /gh api failed/);
  assert.throws(() => plan({ tagExists: () => true, releaseExists: boom }), /gh api failed/);
});

test("exists: 200 is true, 404 is false, anything else throws", () => {
  const answer = (r) => () => r;
  assert.equal(exists(answer({ code: 0, stdout: "", stderr: "" }), "p"), true);
  assert.equal(exists(answer({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }), "p"), false);
  assert.throws(() => exists(answer({ code: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)" }), "p"), /HTTP 502/);
  assert.throws(() => exists(answer({ code: 1, stdout: "", stderr: "error connecting to api.github.com" }), "p"), /connecting/);
  assert.throws(() => exists(answer({ code: 4, stdout: "", stderr: "" }), "p"), /failed \(4\)/);
});

test("changeset front matter: releases, empty, and unreadable", () => {
  assert.deepEqual(changesetReleases(CHANGESET), [{ name: "context-economy", type: "minor" }]);
  assert.deepEqual(changesetReleases("---\ncontext-economy: patch\n'other': none\n---\n"), [
    { name: "context-economy", type: "patch" },
    { name: "other", type: "none" },
  ]);
  assert.deepEqual(changesetReleases(EMPTY), []);
  assert.deepEqual(changesetReleases("---\n\n---\n\nSummary only.\n"), []);
  assert.throws(() => changesetReleases("no front matter\n", "x.md"), /x\.md: no front matter/);
  assert.throws(() => changesetReleases('---\n"context-economy": huge\n---\n', "x.md"), /cannot read release line/);
  assert.throws(() => changesetReleases("---\njust text\n---\n", "x.md"), /cannot read release line/);
});

test("pendingChangesets counts .md files but README.md, and which of them release something", () => {
  const dir = changesetDir({ "README.md": "# Changesets\n", "config.json": "{}", "a.md": CHANGESET, "b.md": EMPTY });
  assert.deepEqual(pendingChangesets(dir), { total: 2, releasing: 1 });
  assert.deepEqual(pendingChangesets(changesetDir({ "README.md": "x" })), NONE);
  assert.throws(() => pendingChangesets(changesetDir({ "bad.md": "nothing\n" })), /bad\.md/);
});

/**
 * A runner for the fixture: `gh api` answers the tag from the fixture's bare remote and the
 * release from fakeGh's set; every other command goes to fakeGh (and git to the fixture).
 */
function stateRunner(fx, gh, { failApi = false } = {}) {
  return (cmd, args) => {
    if (cmd !== "gh" || args[0] !== "api") return gh.run(cmd, args);
    if (failApi) return { code: 1, stdout: "", stderr: "gh: Bad Gateway (HTTP 502)" };
    const path = args.at(-1);
    let m = path.match(/^repos\/o\/r\/git\/ref\/tags\/(.+)$/);
    if (m) {
      const out = must(fx.run, "git", ["ls-remote", "origin", `refs/tags/${m[1]}`]);
      return out ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    m = path.match(/^repos\/o\/r\/releases\/tags\/(.+)$/);
    if (m) return gh.releases.has(m[1]) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    return { code: 1, stdout: "", stderr: `unexpected api path ${path}` };
  };
}

function withChangesetDir(fx, files = {}) {
  mkdirSync(join(fx.root, ".changeset"), { recursive: true });
  writeFileSync(join(fx.root, ".changeset", "README.md"), "# Changesets\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(fx.root, ".changeset", name), text);
}

test("end to end: untagged -> run; tag pushed but release failed -> repair; complete -> nothing", () => {
  const fx = fixtureRepo();
  withChangesetDir(fx);
  const sha = bumpAndCommit(fx, "0.2.0");
  const gh = fakeGh(fx.run);
  const planNow = () => planFor({ run: stateRunner(fx, gh), root: fx.root, repo: REPO });

  assert.equal(planNow().run, true);

  // A run that pushed the tag and failed before creating its release.
  must(fx.run, "git", ["tag", "-a", "v0.2.0", sha, "-m", "context-economy v0.2.0"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/v0.2.0"]);
  const partial = planNow();
  assert.equal(partial.run, true);
  assert.match(partial.reason, /repair/);

  // The gated job's tag-release.mjs then repairs it without moving the tag.
  const r = tagRelease({ run: gh.run, root: fx.root });
  assert.deepEqual([r.sha, r.tagged, r.released], [sha, "skipped", "created"]);

  // A retry after the complete run does nothing.
  const done = planNow();
  assert.equal(done.run, false);
  assert.match(done.reason, /nothing to do/);
});

test("end to end: a pending changeset wins over a released version", () => {
  const fx = fixtureRepo();
  const gh = fakeGh(fx.run, new Set(["v0.1.0"]));
  must(fx.run, "git", ["tag", "-a", "v0.1.0", "HEAD", "-m", "v0.1.0"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/v0.1.0"]);
  withChangesetDir(fx, { "a.md": CHANGESET });
  assert.equal(planFor({ run: stateRunner(fx, gh), root: fx.root, repo: REPO }).run, true);
});

test("end to end: an API failure fails the plan", () => {
  const fx = fixtureRepo();
  withChangesetDir(fx);
  assert.throws(() => planFor({ run: stateRunner(fx, fakeGh(fx.run), { failApi: true }), root: fx.root, repo: REPO }), /HTTP 502/);
});

test("end to end: a missing .changeset directory or a bad repository name fails", () => {
  const fx = fixtureRepo();
  assert.throws(() => planFor({ run: never, root: fx.root, repo: REPO }), /ENOENT/);
  withChangesetDir(fx);
  assert.throws(() => planFor({ run: never, root: fx.root, repo: "not a repo" }), /owner\/repo/);
});
