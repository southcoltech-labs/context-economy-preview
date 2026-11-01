// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { promote } from "./promote.mjs";
import { must } from "./release-lib.mjs";
import { bumpAndCommit, commitAll, fakeGh, fixtureRepo, passingProof, readJson, tagAndPush, writeJson } from "./test-fixture.mjs";

const releaseAt = (fx) => must(fx.run, "git", ["ls-remote", "--heads", "origin", "refs/heads/release"]).split(/\s+/)[0] || undefined;
const yes = () => true;

/** The fixture's fake `gh` (one per fixture), so release status persists across runs. */
const ghOf = (fx, opts) => (fx.gh ??= fakeGh(fx.run, new Set(), opts));

/** A candidate vX tagged and pushed, its prerelease created, and a passing proof on main. */
function candidate(fx, version) {
  const sha = bumpAndCommit(fx, version);
  tagAndPush(fx, `v${version}`, sha);
  const gh = ghOf(fx);
  gh.releases.add(`v${version}`);
  gh.status.set(`v${version}`, { prerelease: true, latest: false });
  writeJson(fx.root, `docs/release-proof/${version}.json`, passingProof(version, sha));
  return sha;
}

const go = (fx, tag, extra = {}) => promote({ run: ghOf(fx).run, root: fx.root, tag, ciPassed: yes, ...extra });

test("first promotion creates release at the tag", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  const r = go(fx, "v0.2.0");
  assert.equal(r.status, "promoted");
  assert.equal(releaseAt(fx), sha);
});

test("promoting the commit release already holds is a successful no-op", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  assert.equal(go(fx, "v0.2.0").status, "unchanged");
  assert.equal(releaseAt(fx), sha);
});

test("a later version fast-forwards release", () => {
  const fx = fixtureRepo();
  candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  const b = candidate(fx, "0.3.0");
  assert.equal(go(fx, "v0.3.0").status, "promoted");
  assert.equal(releaseAt(fx), b);
});

test("the same version at a different commit is refused and release is kept", () => {
  const fx = fixtureRepo();
  const a = candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  // A second tag carrying the same version: the host would never deliver it to existing users.
  const c = commitAll(fx.run, "same version");
  must(fx.run, "git", ["tag", "-a", "v0.2.0-again", c, "-m", "x"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/v0.2.0-again"]);
  assert.throws(() => go(fx, "v0.2.0-again"), /does not match its package.json version/);
  // And through a correctly named tag on a rewritten branch: release holds 0.2.0 already.
  must(fx.run, "git", ["push", "-q", "--force", "origin", `${a}:refs/heads/release`]);
  writeJson(fx.root, "docs/release-proof/0.2.0.json", passingProof("0.2.0", c));
  must(fx.run, "git", ["tag", "-f", "-a", "v0.2.0", c, "-m", "moved"]);
  // Without its promoted tag (covered by its own tests), the same-version rule still refuses.
  must(fx.run, "git", ["push", "-q", "origin", ":refs/tags/promoted-v0.2.0"]);
  assert.throws(() => promote({ run: noFetchTags(fx.run), root: fx.root, tag: "v0.2.0", ciPassed: yes }), /already holds version 0.2.0/);
  assert.equal(releaseAt(fx), a);
});

test("a move that is not a fast-forward is refused", () => {
  const fx = fixtureRepo();
  const base = must(fx.run, "git", ["rev-parse", "HEAD"]);
  candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  const a = releaseAt(fx);
  must(fx.run, "git", ["checkout", "-q", "-b", "side", base]);
  candidate(fx, "0.3.0");
  assert.throws(() => go(fx, "v0.3.0"), /not an ancestor/);
  assert.equal(releaseAt(fx), a);
});

test("a stale attempt fails when release moved after verification, and changes nothing", () => {
  const fx = fixtureRepo();
  candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  const b = candidate(fx, "0.3.0");
  const c = candidate(fx, "0.4.0");
  // A concurrent promotion of v0.3.0 lands between our verification and our push.
  const beforePush = () => must(fx.run, "git", ["push", "-q", "origin", `${b}:refs/heads/release`]);
  assert.throws(() => go(fx, "v0.4.0", { beforePush }), /moved since it was verified/);
  assert.equal(releaseAt(fx), b);
  assert.notEqual(releaseAt(fx), c);
});

test("a concurrent first promotion is caught by the empty lease", () => {
  const fx = fixtureRepo();
  const a = candidate(fx, "0.2.0");
  const b = candidate(fx, "0.3.0");
  const beforePush = () => must(fx.run, "git", ["push", "-q", "origin", `${a}:refs/heads/release`]);
  assert.throws(() => go(fx, "v0.3.0", { beforePush }), /moved since it was verified/);
  assert.equal(releaseAt(fx), a);
  assert.notEqual(releaseAt(fx), b);
});

test("missing tag, failed CI, or an incomplete proof is refused before any push", () => {
  const fx = fixtureRepo();
  assert.throws(() => go(fx, "v9.9.9"), /does not exist/);
  candidate(fx, "0.2.0");
  assert.throws(() => go(fx, "v0.2.0", { ciPassed: () => false }), /CI checks/);
  const proof = passingProof("0.2.0", "f".repeat(40));
  writeJson(fx.root, "docs/release-proof/0.2.0.json", proof);
  assert.throws(() => go(fx, "v0.2.0"), /not a complete pass/);
  assert.equal(releaseAt(fx), undefined);
});

test("a tag whose manifests are out of sync is refused", () => {
  const fx = fixtureRepo();
  bumpAndCommit(fx, "0.2.0");
  writeJson(fx.root, "plugins/tool-gateway/.claude-plugin/plugin.json", { name: "tool-gateway", version: "0.1.0" });
  const bad = commitAll(fx.run, "drift");
  tagAndPush(fx, "v0.2.0", bad);
  writeJson(fx.root, "docs/release-proof/0.2.0.json", passingProof("0.2.0", bad));
  assert.throws(() => go(fx, "v0.2.0"), /tool-gateway at v0.2.0 is not version 0.2.0/);
  assert.equal(releaseAt(fx), undefined);
});

/** Keeps a locally moved tag: skips the tag refresh from the remote. */
function noFetchTags(run) {
  return (cmd, args) => (cmd === "git" && args[0] === "fetch" && args.includes("--tags") ? { code: 0, stdout: "", stderr: "" } : run(cmd, args));
}

// Promoted tags, retries, immutability, release status.

const remoteTags = (fx) => Object.fromEntries(
  must(fx.run, "git", ["ls-remote", "--tags", "origin"]).split("\n").filter(Boolean).map((l) => l.split(/\s+/).reverse()),
);
const promotedAt = (fx, version) => remoteTags(fx)[`refs/tags/promoted-v${version}^{}`];
const isAnnotated = (fx, version) => remoteTags(fx)[`refs/tags/promoted-v${version}`] !== undefined && promotedAt(fx, version) !== undefined;
const statusOf = (fx, tag) => ghOf(fx).status.get(tag);
const interrupt = () => { throw new Error("interrupted"); };

test("promotion creates the annotated promoted tag at the candidate and marks the release latest", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: true, latest: false });
  const r = go(fx, "v0.2.0");
  assert.deepEqual([r.status, r.promotedTag, r.tagStatus, r.release], ["promoted", "promoted-v0.2.0", "created", "latest"]);
  assert.equal(promotedAt(fx, "0.2.0"), sha);
  assert.ok(isAnnotated(fx, "0.2.0"));
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: false, latest: true });
});

test("preflight: a promoted tag at another commit refuses before release or anything else changes", () => {
  const fx = fixtureRepo();
  const other = commitAll(fx.run, "elsewhere");
  must(fx.run, "git", ["tag", "-a", "promoted-v0.2.0", other, "-m", "squat"]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/promoted-v0.2.0"]);
  candidate(fx, "0.2.0");
  assert.throws(() => go(fx, "v0.2.0"), /promoted-v0.2.0 already names .* promoted tags are never moved/);
  assert.equal(releaseAt(fx), undefined);
  assert.equal(promotedAt(fx, "0.2.0"), other);
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: true, latest: false });
  assert.equal(ghOf(fx).calls.filter((a) => a[1] === "edit").length, 0);
});

test("preflight: a lightweight promoted tag, even at the candidate, is refused and left alone", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  must(fx.run, "git", ["tag", "promoted-v0.2.0", sha]);
  must(fx.run, "git", ["push", "-q", "origin", "refs/tags/promoted-v0.2.0"]);
  assert.throws(() => go(fx, "v0.2.0"), /not an annotated tag/);
  assert.equal(releaseAt(fx), undefined);
  assert.ok(!isAnnotated(fx, "0.2.0"));
});

test("interrupted after the branch move: the retry finds release at the candidate and finishes tag and status", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  assert.throws(() => go(fx, "v0.2.0", { beforeTag: interrupt }), /interrupted/);
  assert.equal(releaseAt(fx), sha);
  assert.equal(promotedAt(fx, "0.2.0"), undefined);
  const r = go(fx, "v0.2.0");
  assert.deepEqual([r.status, r.tagStatus, r.release], ["unchanged", "created", "latest"]);
  assert.equal(promotedAt(fx, "0.2.0"), sha);
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: false, latest: true });
});

test("interrupted after the tag push, before the release edit: the retry only finishes the status", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  assert.throws(() => go(fx, "v0.2.0", { beforeRelease: interrupt }), /interrupted/);
  assert.equal(promotedAt(fx, "0.2.0"), sha);
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: true, latest: false });
  const r = go(fx, "v0.2.0");
  assert.deepEqual([r.status, r.tagStatus, r.release], ["unchanged", "exists", "latest"]);
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: false, latest: true });
});

test("a failed release edit fails the run; a retry with gh working completes it", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  const broken = fakeGh(fx.run, ghOf(fx).releases, { failEdit: true });
  assert.throws(() => promote({ run: broken.run, root: fx.root, tag: "v0.2.0", ciPassed: yes }), /release edit .* failed/);
  assert.equal(releaseAt(fx), sha);
  assert.equal(promotedAt(fx, "0.2.0"), sha);
  assert.equal(go(fx, "v0.2.0").release, "latest");
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: false, latest: true });
});

test("retrying a completed promotion is safe: nothing moves, tag kept", () => {
  const fx = fixtureRepo();
  const sha = candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  const before = remoteTags(fx)["refs/tags/promoted-v0.2.0"];
  const r = go(fx, "v0.2.0");
  assert.deepEqual([r.status, r.tagStatus], ["unchanged", "exists"]);
  assert.equal(releaseAt(fx), sha);
  assert.equal(remoteTags(fx)["refs/tags/promoted-v0.2.0"], before);
});

test("an old retry after a newer promotion changes nothing and keeps the newer release latest", () => {
  const fx = fixtureRepo();
  const a = candidate(fx, "0.2.0");
  go(fx, "v0.2.0");
  const b = candidate(fx, "0.3.0");
  go(fx, "v0.3.0");
  assert.throws(() => go(fx, "v0.2.0"), /not an ancestor/);
  assert.equal(releaseAt(fx), b);
  assert.equal(promotedAt(fx, "0.2.0"), a);
  assert.deepEqual(statusOf(fx, "v0.3.0"), { prerelease: false, latest: true });
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: false, latest: false });
});

test("a newer promotion landing before the release edit: the older candidate is not marked latest", () => {
  const fx = fixtureRepo();
  const a = candidate(fx, "0.2.0");
  const b = candidate(fx, "0.3.0");
  const newer = () => must(fx.run, "git", ["push", "-q", "--force", "origin", `${b}:refs/heads/release`]);
  assert.throws(() => go(fx, "v0.2.0", { beforeRelease: newer }), /release is at .*, not .*; release status left unchanged/);
  assert.equal(promotedAt(fx, "0.2.0"), a);
  assert.deepEqual(statusOf(fx, "v0.2.0"), { prerelease: true, latest: false });
});

test("the placeholder version 0.0.0 is never promoted", () => {
  const fx = fixtureRepo("0.0.0");
  const sha = must(fx.run, "git", ["rev-parse", "HEAD"]);
  tagAndPush(fx, "v0.0.0", sha);
  writeJson(fx.root, "docs/release-proof/0.0.0.json", passingProof("0.0.0", sha));
  assert.throws(() => go(fx, "v0.0.0"), /unreleased placeholder/);
  assert.equal(releaseAt(fx), undefined);
});

// The Pi proof cannot be switched off by the candidate or skipped by the proof.

/** Everything promotion could change: release, every remote tag, every release status, gh edits. */
const snapshot = (fx) => ({
  release: releaseAt(fx),
  tags: must(fx.run, "git", ["ls-remote", "--tags", "origin"]),
  status: JSON.stringify([...ghOf(fx).status.entries()]),
  edits: ghOf(fx).calls.filter((a) => a[1] === "edit").length,
});

for (const [label, pi] of [["missing", undefined], ["not an array", { extensions: "./extensions/a/index.ts" }], ["empty", { extensions: [] }]]) {
  test(`a candidate whose package.json pi.extensions is ${label} is refused, and nothing changes`, () => {
    const fx = fixtureRepo();
    const pkg = readJson(fx.root, "package.json");
    if (pi === undefined) delete pkg.pi; else pkg.pi = pi;
    writeJson(fx.root, "package.json", pkg);
    commitAll(fx.run, "drop the Pi manifest");
    candidate(fx, "0.2.0");
    // The proof also lacks Pi blocks, as a candidate without Pi would ship with.
    const proof = readJson(fx.root, "docs/release-proof/0.2.0.json");
    for (const r of proof.runs) delete r.pi;
    writeJson(fx.root, "docs/release-proof/0.2.0.json", proof);
    const before = snapshot(fx);
    assert.throws(() => go(fx, "v0.2.0"), /v0.2.0: package.json pi.extensions must list at least one/);
    assert.deepEqual(snapshot(fx), before);
  });
}

test("a proof whose runs lack the pi block is refused, and nothing changes", () => {
  const fx = fixtureRepo();
  candidate(fx, "0.2.0");
  const proof = readJson(fx.root, "docs/release-proof/0.2.0.json");
  for (const r of proof.runs) delete r.pi;
  writeJson(fx.root, "docs/release-proof/0.2.0.json", proof);
  const before = snapshot(fx);
  assert.throws(() => go(fx, "v0.2.0"), /macos-arm64: pi block missing[\s\S]*linux-x86_64: pi block missing/);
  assert.deepEqual(snapshot(fx), before);
});

test("a proof with one platform's Pi run failed is refused, and nothing changes", () => {
  const fx = fixtureRepo();
  candidate(fx, "0.2.0");
  const proof = readJson(fx.root, "docs/release-proof/0.2.0.json");
  proof.runs[1].pi.result = "fail";
  writeJson(fx.root, "docs/release-proof/0.2.0.json", proof);
  const before = snapshot(fx);
  assert.throws(() => go(fx, "v0.2.0"), /linux-x86_64: pi result is fail/);
  assert.deepEqual(snapshot(fx), before);
});
