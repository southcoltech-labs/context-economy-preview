#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Every pull request carries a changeset, with two separately scoped exemptions.
//   - Docs-only, labeled `no-release`: every changed path is documentation that ships to no
//     user (DOCS_ONLY). A label on a PR that also changes anything else grants nothing.
//   - The generated version PR: head branch `changeset-release/main` in this repository (a
//     fork can name a branch the same). It consumes changesets instead of adding one.
// Otherwise `changeset status --since=<base>` decides.
//
//   BASE_REF=main HEAD_REF=... HEAD_REPO=o/r GITHUB_REPOSITORY=o/r PR_LABELS='["no-release"]' \
//     node scripts/changeset-gate.mjs
import { pathToFileURL } from "node:url";
import { makeRunner, must } from "./release-lib.mjs";

// Plugin directories are never docs: their Markdown includes commands, skills and agents.
const DOCS_ONLY = [/^docs\//, /^[^/]+\.md$/, /^\.changeset\/README\.md$/, /^LICENSE$/, /^NOTICE$/];

export const isDocsPath = (path) => DOCS_ONLY.some((re) => re.test(path));

/** { exempt: true, reason } when no changeset is needed, else { exempt: false, reason }. */
export function changesetGate({ files, labels, headRef, headRepo, repo }) {
  if (headRef === "changeset-release/main" && headRepo && headRepo === repo) {
    return { exempt: true, reason: "generated version PR" };
  }
  if (labels.includes("no-release")) {
    const other = files.filter((f) => !isDocsPath(f));
    if (!files.length || other.length) {
      return { exempt: false, reason: `labeled no-release but not docs-only: ${other.join(", ") || "(no files)"}` };
    }
    return { exempt: true, reason: "docs-only, labeled no-release" };
  }
  return { exempt: false, reason: "changeset required" };
}

/** Every path the branch touches. `--no-renames` lists a move as its old path and its new one. */
export const changedFiles = (run, base) =>
  must(run, "git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`]).split("\n").filter(Boolean);

function main(env = process.env) {
  const run = makeRunner(process.cwd());
  const base = `origin/${env.BASE_REF}`;
  const gate = changesetGate({
    files: changedFiles(run, base),
    labels: JSON.parse(env.PR_LABELS || "[]"),
    headRef: env.HEAD_REF,
    headRepo: env.HEAD_REPO,
    repo: env.GITHUB_REPOSITORY,
  });
  console.log(`changeset gate: ${gate.reason}`);
  if (gate.exempt) return 0;
  const r = run("npx", ["changeset", "status", `--since=${base}`]);
  process.stdout.write(r.stdout + "\n" + r.stderr + "\n");
  return r.code === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
