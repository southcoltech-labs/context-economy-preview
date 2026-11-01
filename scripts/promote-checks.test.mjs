// SPDX-License-Identifier: Apache-2.0

// Promotion's CI gate through the real CLI path: REQUIRED_CHECKS as promote.yml sets it, parsed
// by main(), answered by a GitHub check-runs response (fake `gh`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, requiredChecks } from "./promote.mjs";
import { must } from "./release-lib.mjs";
import { bumpAndCommit, fixtureRepo, passingProof, tagAndPush, writeJson } from "./test-fixture.mjs";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const read = (name) => readFileSync(join(WORKFLOWS, name), "utf8");

/** Check-run names ci.yml produces: each job's `name:` expanded over its matrix lists. */
export function ciCheckNames(yml) {
  const jobs = yml.slice(yml.indexOf("\njobs:\n")).split(/\n(?=  [\w-]+:\n)/).slice(1);
  return jobs.flatMap((block) => {
    const name = block.match(/^ {4}name: (.+)$/m)?.[1] ?? block.match(/^ {2}([\w-]+):/)[1];
    const axes = [...block.matchAll(/^ {8}(\w+): \[(.*?)\]/gm)].map(([, key, list]) => [
      key,
      list.split(",").map((v) => v.trim().replace(/^"|"$/g, "")),
    ]);
    return axes.reduce(
      (names, [key, values]) => names.flatMap((n) => values.map((v) => n.replaceAll(`\${{ matrix.${key} }}`, v))),
      [name],
    );
  });
}

/** The REQUIRED_CHECKS block scalar in promote.yml, as the runner hands it to the script. */
function promoteRequiredChecks() {
  const lines = read("promote.yml").split("\n");
  const start = lines.findIndex((l) => /^\s+REQUIRED_CHECKS: \|$/.test(l));
  const indent = lines[start + 1].match(/^ */)[0].length;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && l.match(/^ */)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

const NAMES = ciCheckNames(read("ci.yml"));
const REQUIRED = promoteRequiredChecks();

test("promote.yml requires exactly the checks ci.yml produces", () => {
  assert.ok(NAMES.includes("plugins (ubuntu-latest)"), NAMES.join(" | "));
  assert.ok(NAMES.includes("pi (macos-latest)"), NAMES.join(" | "));
  assert.equal(NAMES.length, 5);
  assert.deepEqual([...requiredChecks(REQUIRED)].sort(), [...NAMES].sort());
});

test("a two-axis matrix name keeps its comma, in ci.yml's expansion and in REQUIRED_CHECKS", () => {
  const yml = [
    "jobs:",
    "  repo:",
    "    name: repo checks",
    "  test:",
    "    name: test (${{ matrix.os }}, ${{ matrix.python }})",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, macos-latest]",
    '        python: ["3.10", "3.x"]',
    "",
  ].join("\n");
  const names = ciCheckNames("\n" + yml);
  assert.deepEqual(names, [
    "repo checks",
    "test (ubuntu-latest, 3.10)",
    "test (ubuntu-latest, 3.x)",
    "test (macos-latest, 3.10)",
    "test (macos-latest, 3.x)",
  ]);
  assert.deepEqual([...requiredChecks(names.join("\n"))].sort(), [...names].sort());
});

/** A tagged, proven candidate, and a `gh` that answers check-runs for it with `runs`. */
function setup(runs) {
  const fx = fixtureRepo();
  const sha = bumpAndCommit(fx, "0.2.0");
  tagAndPush(fx, "v0.2.0", sha);
  writeJson(fx.root, "docs/release-proof/0.2.0.json", passingProof("0.2.0", sha));
  const asked = [];
  const run = (cmd, args) => {
    if (cmd !== "gh") return fx.run(cmd, args);
    asked.push(args.join(" "));
    if (args[0] === "api" && args.some((a) => a === `repos/o/r/commits/${sha}/check-runs`)) {
      return { code: 0, stdout: runs.map((r) => r.join("\t")).join("\n"), stderr: "" };
    }
    if (args[0] === "release" && args[1] === "edit" && args[2] === "v0.2.0") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected gh call" };
  };
  const errors = [];
  const cli = (env = { REQUIRED_CHECKS: REQUIRED, GITHUB_REPOSITORY: "o/r" }) =>
    main(["v0.2.0"], {
      env,
      root: fx.root,
      run,
      log: { log() {}, error: (m) => errors.push(m) },
    });
  const releaseAt = () => must(fx.run, "git", ["ls-remote", "--heads", "origin", "refs/heads/release"]).split(/\s+/)[0] || undefined;
  return { sha, cli, errors, asked, releaseAt };
}

const green = () => NAMES.map((n) => [n, "completed", "success"]);

test("all required checks green: the CLI promotes", () => {
  const s = setup(green());
  assert.equal(s.cli(), 0, s.errors.join("\n"));
  assert.equal(s.releaseAt(), s.sha);
  assert.ok(s.asked.length > 0);
});

test("a missing, failed or pending check refuses promotion and leaves release alone", () => {
  const cases = {
    missing: green().filter(([n]) => n !== "pi (macos-latest)"),
    failed: green().map((r) => (r[0] === "plugins (ubuntu-latest)" ? [r[0], "completed", "failure"] : r)),
    pending: green().map((r) => (r[0] === "repo checks" ? [r[0], "in_progress", ""] : r)),
    "one of two reruns failed": [...green(), ["pi (ubuntu-latest)", "completed", "failure"]],
  };
  for (const [label, runs] of Object.entries(cases)) {
    const s = setup(runs);
    assert.equal(s.cli(), 1, label);
    assert.match(s.errors.join("\n"), /CI checks/, label);
    assert.equal(s.releaseAt(), undefined, label);
  }
});

test("an unset REQUIRED_CHECKS or repository fails closed", () => {
  for (const env of [{ GITHUB_REPOSITORY: "o/r" }, { REQUIRED_CHECKS: "  \n", GITHUB_REPOSITORY: "o/r" }, { REQUIRED_CHECKS: REQUIRED }]) {
    const s = setup(green());
    assert.equal(s.cli(env), 1, JSON.stringify(env));
    assert.equal(s.releaseAt(), undefined);
  }
});
