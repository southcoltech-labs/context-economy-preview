#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Every commit a pull request adds is signed off by its author under the DCO 1.1 (CONTRIBUTING.md).
// The DCO App skips every merge commit and every bot-authored commit, and offers an override to
// anyone with write access, so this check is the one that holds:
//   - A merge commit fails: branches are rebased, never merged into (a merge can carry changes
//     nobody signed off).
//   - The one unsigned exception is the generated version PR (head `changeset-release/main` in
//     this repository) when the commit's author is the release App's bot, RELEASE_BOT_EMAIL. Until
//     that is set there is no exception.
//
//   BASE_REF=main HEAD_SHA=<sha> HEAD_REF=... HEAD_REPO=o/r GITHUB_REPOSITORY=o/r \
//     RELEASE_BOT_EMAIL=<id>+<slug>[bot]@users.noreply.github.com node scripts/signoff-gate.mjs
import { pathToFileURL } from "node:url";
import { makeRunner, must } from "./release-lib.mjs";

const SIGNOFF = /^Signed-off-by:\s*(.+?)\s*<([^<>\s]+)>\s*$/gim;

/** The `Signed-off-by` identities in a commit message, as { name, email }. */
export const signoffs = (message) => [...message.matchAll(SIGNOFF)].map(([, name, email]) => ({ name, email }));

const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** { ok, problems }: one problem per commit that breaks the rule, naming it. */
export function signoffGate({ commits, headRef, headRepo, repo, botEmail }) {
  const versionPr = headRef === "changeset-release/main" && Boolean(headRepo) && headRepo === repo;
  const problems = [];
  for (const c of commits) {
    const at = `${c.sha.slice(0, 12)} (${c.authorName} <${c.authorEmail}>)`;
    if (c.parents.length > 1) {
      problems.push(`${at}: merge commit; rebase the branch instead of merging into it`);
    } else if (signoffs(c.message).some((s) => same(s.name, c.authorName) && same(s.email, c.authorEmail))) {
      continue;
    } else if (versionPr && botEmail && same(c.authorEmail, botEmail)) {
      continue;
    } else {
      problems.push(`${at}: no Signed-off-by matching its author`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The commits `head` adds over `base`, oldest first. */
export function commitsBetween(run, base, head) {
  const out = must(run, "git", ["log", "--reverse", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%B%x1e", `${base}..${head}`]);
  return out.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => {
    const [sha, parents, authorName, authorEmail, message] = r.split("\x1f");
    return { sha, parents: parents.split(" ").filter(Boolean), authorName, authorEmail, message };
  });
}

function main(env = process.env) {
  const run = makeRunner(process.cwd());
  const gate = signoffGate({
    commits: commitsBetween(run, `origin/${env.BASE_REF}`, env.HEAD_SHA),
    headRef: env.HEAD_REF,
    headRepo: env.HEAD_REPO,
    repo: env.GITHUB_REPOSITORY,
    botEmail: env.RELEASE_BOT_EMAIL,
  });
  for (const p of gate.problems) console.log(`sign-off gate: ${p}`);
  if (!gate.ok) console.log("See CONTRIBUTING.md, Sign-off, for how to fix the branch.");
  else console.log("sign-off gate: every commit is signed off by its author");
  return gate.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
