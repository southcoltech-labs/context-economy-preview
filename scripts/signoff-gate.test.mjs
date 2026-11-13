// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitsBetween, signoffGate, signoffs } from "./signoff-gate.mjs";
import { must } from "./release-lib.mjs";
import { commitAll, fixtureRepo } from "./test-fixture.mjs";

const BOT = "123+context-economy-candidate[bot]@users.noreply.github.com";
const commit = (extra = {}) => ({
  sha: "a".repeat(40), parents: ["b".repeat(40)], authorName: "Ada Lovelace", authorEmail: "ada@example.com",
  message: "Fix it\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n", ...extra,
});
const gate = (commits, extra = {}) =>
  signoffGate({ commits, headRef: "feat", headRepo: "o/r", repo: "o/r", botEmail: BOT, ...extra });

test("a commit signed off by its author passes; name and e-mail compare without case", () => {
  assert.equal(gate([commit()]).ok, true);
  assert.equal(gate([commit({ message: "x\n\nSigned-off-by: ada lovelace <ADA@example.com>" })]).ok, true);
});

test("an unsigned human commit fails, and the problem names it", () => {
  const g = gate([commit(), commit({ sha: "c".repeat(40), message: "No sign-off\n" })]);
  assert.equal(g.ok, false);
  assert.equal(g.problems.length, 1);
  assert.match(g.problems[0], /^cccccccccccc \(Ada Lovelace <ada@example\.com>\): no Signed-off-by/);
});

test("a sign-off by someone other than the author does not count", () => {
  assert.equal(gate([commit({ message: "x\n\nSigned-off-by: Bob <bob@example.com>" })]).ok, false);
  assert.equal(gate([commit({ message: "x\n\nSigned-off-by: Ada Lovelace <other@example.com>" })]).ok, false);
  assert.equal(gate([commit({ message: "x\n\nsigned off by Ada Lovelace <ada@example.com>" })]).ok, false);
});

test("a merge commit fails even when signed off", () => {
  const g = gate([commit({ parents: ["b".repeat(40), "d".repeat(40)] })]);
  assert.equal(g.ok, false);
  assert.match(g.problems[0], /merge commit/);
});

test("the release bot may commit unsigned only in the version PR from this repository", () => {
  const bot = commit({ authorName: "context-economy-candidate[bot]", authorEmail: BOT, message: "Version packages\n" });
  const version = { headRef: "changeset-release/main" };
  assert.equal(gate([bot], version).ok, true);
  assert.equal(gate([bot]).ok, false, "another branch");
  assert.equal(gate([bot], { ...version, headRepo: "fork/r" }).ok, false, "a fork's branch of the same name");
  assert.equal(gate([bot], { ...version, headRepo: undefined }).ok, false);
  assert.equal(gate([bot], { ...version, botEmail: undefined }).ok, false, "no exception until the bot is recorded");
  assert.equal(gate([bot], { ...version, botEmail: "" }).ok, false);
});

test("other bots and humans in the version PR still need a sign-off", () => {
  const version = { headRef: "changeset-release/main" };
  const other = commit({ authorName: "dependabot[bot]", authorEmail: "49699333+dependabot[bot]@users.noreply.github.com", message: "Bump\n" });
  assert.equal(gate([other], version).ok, false);
  assert.equal(gate([commit({ message: "Edit\n" })], version).ok, false);
});

test("signoffs reads every trailer line", () => {
  assert.deepEqual(signoffs("x\n\nSigned-off-by: A <a@x>\nSigned-off-by:  B  C <b@x> \n"), [
    { name: "A", email: "a@x" }, { name: "B  C", email: "b@x" },
  ]);
});

test("commitsBetween reads author, parents and the full message (real git)", () => {
  const fx = fixtureRepo();
  must(fx.run, "git", ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(fx.root, "a.md"), "a\n");
  must(fx.run, "git", ["add", "-A"]);
  must(fx.run, "git", ["commit", "-q", "-s", "-m", "First\n\nBody line"]);
  commitAll(fx.run, "Second, unsigned");
  must(fx.run, "git", ["checkout", "-q", "-b", "side", "main"]);
  commitAll(fx.run, "side");
  must(fx.run, "git", ["checkout", "-q", "feat"]);
  must(fx.run, "git", ["merge", "-q", "--no-edit", "-s", "ours", "side"]);
  const head = must(fx.run, "git", ["rev-parse", "HEAD"]);

  const commits = commitsBetween(fx.run, "main", head);
  const by = Object.fromEntries(commits.map((c) => [c.message.split("\n")[0], c]));
  assert.deepEqual(Object.keys(by).sort(), ["First", "Merge branch 'side' into feat", "Second, unsigned", "side"]);
  assert.equal(by.First.authorEmail, "t@t");
  assert.match(by.First.message, /Body line\n\nSigned-off-by: t <t@t>/);
  assert.equal(by["Merge branch 'side' into feat"].parents.length, 2);
  assert.equal(by.side.parents.length, 1);

  const g = signoffGate({ commits, headRef: "feat", headRepo: "o/r", repo: "o/r", botEmail: BOT });
  assert.deepEqual(g.problems.map((p) => p.replace(/^\w{12} /, "")).sort(), [
    "(t <t@t>): merge commit; rebase the branch instead of merging into it",
    "(t <t@t>): no Signed-off-by matching its author",
    "(t <t@t>): no Signed-off-by matching its author",
  ]);
});
