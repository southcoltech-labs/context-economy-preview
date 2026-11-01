#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// The publish step of the release workflow. Tags the commit that released the current
// version and creates its GitHub release. Nothing goes to npm, and tagging reaches no user:
// only promotion (scripts/promote.mjs) moves the release ref.
//
// The target is chosen from parsed snapshots, not from text changes or HEAD: walking main's
// first-parent history back from HEAD while the root package.json version stays the current
// one, it is the earliest commit whose manifests are all in sync. So a broken bump followed by
// a sync fix-up tags the fix-up, and later unrelated commits (scripts, formatting) never move
// it. The target snapshot itself is checked, read with `git show`.
//   tag missing                              -> create it at the target and push it
//   tag at the target, or at another synced
//   commit of this version on main           -> skip; the published tag keeps its identity
//   tag anywhere else                        -> fail; nothing is changed
//   release missing for the tag              -> create it from that version's CHANGELOG section,
//                                               as a prerelease: a candidate is not an install route
//                                               until promotion marks it latest
//   HEAD at the placeholder 0.0.0            -> nothing tagged or released, exit 0
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commitOf, jsonAt, makeRunner, must, PLACEHOLDER_VERSION, showAt, SEMVER } from "./release-lib.mjs";
import { driftOf } from "./sync-plugin-version.mjs";

/** Version drift in one commit's snapshot. */
export const driftAt = (run, sha) => driftOf((rel) => jsonAt(run, sha, rel));

const versionAt = (run, sha) => {
  const text = showAt(run, sha, "package.json");
  return text === undefined ? undefined : JSON.parse(text).version;
};

export function releaseTarget(run) {
  const head = must(run, "git", ["rev-parse", "HEAD"]);
  const version = versionAt(run, head);
  if (!SEMVER.test(String(version))) throw new Error(`package.json version ${version} is not x.y.z`);
  const atVersion = [];
  for (const sha of must(run, "git", ["rev-list", "--first-parent", head]).split("\n")) {
    if (versionAt(run, sha) !== version) break;
    atVersion.push(sha);
  }
  const synced = atVersion.filter((sha) => driftAt(run, sha).lines.length === 0);
  if (!synced.length) {
    const lines = driftAt(run, head).lines;
    throw new Error(`version drift; no commit at ${version} is in sync. Fix before tagging:\n  ${lines.join("\n  ")}`);
  }
  return { version, tag: `v${version}`, sha: synced.at(-1), synced };
}

/** The `## <version>` section of a Changesets CHANGELOG, without its heading. */
export function changelogSection(text, version) {
  if (!text) return undefined;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

export function tagRelease({ run, remote = "origin" }) {
  const head = must(run, "git", ["rev-parse", "HEAD"]);
  const headVersion = versionAt(run, head);
  if (headVersion === PLACEHOLDER_VERSION) {
    return { version: headVersion, tag: undefined, sha: head, tagged: "skipped", released: "skipped", placeholder: true };
  }
  const target = releaseTarget(run);
  const { version, tag } = target;
  let { sha } = target;
  must(run, "git", ["fetch", "--force", "--tags", remote]);
  const existing = commitOf(run, `refs/tags/${tag}`);
  let tagged = "skipped";
  if (existing && existing !== sha) {
    if (!target.synced.includes(existing)) {
      throw new Error(`${tag} already exists at ${existing}, not a synced ${version} commit on this branch; refusing to move it`);
    }
    sha = existing;
  }
  if (!existing) {
    must(run, "git", ["tag", "-a", tag, sha, "-m", `context-economy ${tag}`]);
    must(run, "git", ["push", remote, `refs/tags/${tag}`]);
    tagged = "created";
  }
  let released = "skipped";
  if (run("gh", ["release", "view", tag, "--json", "tagName"]).code !== 0) {
    const notes = changelogSection(showAt(run, sha, "CHANGELOG.md"), version) || `Release ${tag}.`;
    const file = join(mkdtempSync(join(tmpdir(), "tag-release-")), "notes.md");
    writeFileSync(file, notes + "\n");
    must(run, "gh", ["release", "create", tag, "--verify-tag", "--prerelease", "--title", tag, "--notes-file", file]);
    released = "created";
  }
  return { version, tag, sha, tagged, released };
}

function main() {
  const root = process.cwd();
  try {
    const r = tagRelease({ run: makeRunner(root) });
    console.log(r.placeholder
      ? `version ${PLACEHOLDER_VERSION} is the unreleased placeholder; nothing tagged`
      : `${r.tag} at ${r.sha}: tag ${r.tagged}, release ${r.released}`);
    return 0;
  } catch (e) {
    console.error(`tag-release: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
