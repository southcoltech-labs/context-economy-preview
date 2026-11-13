#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// The first job of release.yml: decides from the release state on main whether the gated job
// (version PR, tag, release) has anything to do. It runs with no environment, no secrets and a
// read-only token, and passes on only `run=true` or `run=false`. It never decides *what* to tag:
// target selection, the sync check and the refusal to move a tag stay in tag-release.mjs.
//
// The answer mirrors the pinned changesets/action (v2.1.2), which the gated job runs:
//   a pending changeset that releases something      -> run: open or update the version PR
//                                                       (first, even at the placeholder version)
//   pending changesets, all empty                    -> nothing: the action does nothing either
//   no changesets, version 0.0.0                     -> nothing: tag-release.mjs skips the placeholder
//   no changesets, v<version> tag missing            -> run: tag and create the prerelease
//   no changesets, tag present, GitHub release gone  -> run: repair the release (V6)
//   tag and release both present                     -> nothing, also on a retry after a complete run
// A state it cannot read (a parse error, an API error other than "not found") fails the job; it
// is never read as "nothing to do".
//
//   GITHUB_REPOSITORY=o/r GH_TOKEN=<read-only> GITHUB_OUTPUT=<file> node scripts/release-plan.mjs
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeRunner, PLACEHOLDER_VERSION, SEMVER } from "./release-lib.mjs";

const BUMPS = new Set(["major", "minor", "patch", "none"]);

/**
 * The releases a changeset's front matter lists, as [{ name, type }]. Throws on anything that is
 * not a Changesets front matter, so an unreadable changeset fails the job instead of being skipped.
 */
export function changesetReleases(text, file = "changeset") {
  const m = text.replace(/\r\n/g, "\n").match(/^\s*---\n([\s\S]*?)\n?---(\n|$)/);
  if (!m) throw new Error(`${file}: no front matter`);
  const releases = [];
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const r = line.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s:'"]+))\s*:\s*(\S+)\s*$/);
    if (!r || !BUMPS.has(r[4])) throw new Error(`${file}: cannot read release line: ${line.trim()}`);
    releases.push({ name: r[1] ?? r[2] ?? r[3], type: r[4] });
  }
  return releases;
}

/** The pending changesets in `.changeset/`, README.md excluded, as { total, releasing }. */
export function pendingChangesets(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const releasing = files.filter((f) => changesetReleases(readFileSync(join(dir, f), "utf8"), f).length > 0);
  return { total: files.length, releasing: releasing.length };
}

/**
 * Whether a GitHub API path exists: true, false on a 404, and a throw on any other failure.
 * `gh api` exits 1 for both, so the 404 is read from its message.
 */
export function exists(run, path) {
  const r = run("gh", ["api", "--silent", path]);
  if (r.code === 0) return true;
  if (/\bHTTP 404\b/.test(r.stderr)) return false;
  throw new Error(`gh api ${path} failed (${r.code}): ${r.stderr || r.stdout || "no output"}`);
}

/**
 * The decision, as { run, reason }. `tagExists` and `releaseExists` are asked only when needed,
 * so a run that stops earlier makes no API call.
 */
export function releasePlan({ changesets, version, tagExists, releaseExists }) {
  if (changesets.releasing > 0) return { run: true, reason: `${changesets.releasing} pending changeset(s): open or update the version PR` };
  if (changesets.total > 0) return { run: false, reason: `${changesets.total} pending changeset(s), all empty: nothing to version or tag` };
  if (version === PLACEHOLDER_VERSION) return { run: false, reason: `version ${PLACEHOLDER_VERSION} is the unreleased placeholder` };
  if (!SEMVER.test(String(version))) throw new Error(`package.json version ${version} is not x.y.z`);
  const tag = `v${version}`;
  if (!tagExists(tag)) return { run: true, reason: `${tag} is not tagged: tag it and create the prerelease` };
  if (!releaseExists(tag)) return { run: true, reason: `${tag} has no GitHub release: repair it` };
  return { run: false, reason: `${tag} and its release exist: nothing to do` };
}

/** Reads the state from a checkout of main at `root` and the repository `repo` on GitHub. */
export function planFor({ run, root, repo }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error(`GITHUB_REPOSITORY ${repo} is not owner/repo`);
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  return releasePlan({
    changesets: pendingChangesets(join(root, ".changeset")),
    version,
    tagExists: (tag) => exists(run, `repos/${repo}/git/ref/tags/${tag}`),
    releaseExists: (tag) => exists(run, `repos/${repo}/releases/tags/${tag}`),
  });
}

function main(env = process.env) {
  const root = process.cwd();
  try {
    const plan = planFor({ run: makeRunner(root), root, repo: env.GITHUB_REPOSITORY });
    console.log(`release plan: ${plan.reason}`);
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is not set");
    appendFileSync(env.GITHUB_OUTPUT, `run=${plan.run}\n`);
    return 0;
  } catch (e) {
    console.error(`release-plan: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
