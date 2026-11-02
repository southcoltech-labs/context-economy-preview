#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Lists the sections of docs/REVIEWING.md that a pull request's changed paths call for, and any
// test files it deletes, in the run's summary. It informs the reviewer and never fails, even when
// git or the summary file does: the review, not this list, is the control (REVIEWING.md).
//
//   BASE_REF=main HEAD_REF=... GITHUB_STEP_SUMMARY=<file> node scripts/review-scope.mjs
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeRunner, must } from "./release-lib.mjs";

/** Section headings of docs/REVIEWING.md, each with the paths that call for it. First match wins. */
export const SECTIONS = [
  ["Checks and review rules", [
    /^scripts\/(signoff-gate|changeset-gate|review-scope)(\.test)?\.mjs$/, /^scripts\/workflow-policy(\.test)?\.mjs$/,
    /^\.github\/CODEOWNERS$/, /^\.github\/pull_request_template\.md$/, /^docs\/REVIEWING\.md$/,
  ]],
  ["Workflows", [/^\.github\/workflows\//]],
  ["Release tooling", [/^scripts\//, /^\.changeset\/config\.json$/]],
  ["Dependencies", [/^package(-lock)?\.json$/]],
  ["Repository configuration", [/^\.gitleaks\.toml$/, /^\.claude-plugin\//, /(^|\/)plugin\.json$/, /^\.github\//]],
  ["Runtime", [/^plugins\//, /^extensions\//]],
  ["Legal and security documents", [/^(LICENSE|NOTICE|SECURITY\.md|CONTRIBUTING\.md)$/]],
];

const TEST_FILE = /\.test\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/;

/** { sections, deletedTests } for the changed files, as [status, path] pairs from git. */
export function reviewScope({ changes, headRef }) {
  const hit = new Set(["All pull requests"]);
  for (const [, path] of changes) {
    const section = SECTIONS.find(([, patterns]) => patterns.some((re) => re.test(path)));
    if (section) hit.add(section[0]);
  }
  if (headRef === "changeset-release/main") hit.add("The version pull request");
  const order = ["All pull requests", ...SECTIONS.map(([name]) => name), "The version pull request"];
  return {
    sections: order.filter((name) => hit.has(name)),
    deletedTests: changes.filter(([status, path]) => status === "D" && TEST_FILE.test(path)).map(([, path]) => path),
  };
}

/** [status, path] for each path the branch changes against its merge base; a move is D plus A. */
export const changes = (run, base) =>
  must(run, "git", ["diff", "--name-status", "--no-renames", `${base}...HEAD`])
    .split("\n").filter(Boolean).map((line) => line.split("\t"));

export function summary({ sections, deletedTests }, changed) {
  const lines = [
    "## Review scope",
    "",
    `${changed} changed paths. Sections of [docs/REVIEWING.md](docs/REVIEWING.md) to go through:`,
    "",
    ...sections.map((s) => `- [ ] ${s}`),
  ];
  if (deletedTests.length) lines.push("", "**Deleted test files:**", "", ...deletedTests.map((p) => `- \`${p}\``));
  return lines.join("\n") + "\n";
}

/**
 * Best effort: a git or summary-file failure is reported and the step still succeeds, because
 * this list is advisory. The enforcing gates are separate steps and fail normally.
 */
export function main(env = process.env, run = makeRunner(process.cwd()), out = (t) => process.stdout.write(t)) {
  let text;
  try {
    const changed = changes(run, `origin/${env.BASE_REF}`);
    text = summary(reviewScope({ changes: changed, headRef: env.HEAD_REF }), changed.length);
  } catch (e) {
    text = `## Review scope\n\nUnavailable: ${e.message.split("\n")[0].replace(/\.$/, "")}. Go through every section of docs/REVIEWING.md that the changed paths call for.\n`;
  }
  out(text);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    } catch (e) {
      out(`review scope: could not write the run summary: ${e.message}\n`);
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
