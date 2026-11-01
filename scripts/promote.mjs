#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// Move the release ref, which is what users install (`<owner>/<repo>#release`), to a tag.
// Runs from a trusted main checkout. The candidate is read with `git show` only; nothing from
// the tag is checked out or executed.
//
// Refuses unless: the tag exists and names its own version; that version is synced across
// the tag's manifests; the required CI checks passed at the tag's commit; main holds a
// complete passing E1a proof for that commit; and the move is a fast-forward to a new version.
// The push is guarded by the SHA that was verified, so a concurrent or stale attempt changes
// nothing. The placeholder version 0.0.0 is never promoted.
//
// Once release is at the candidate, promotion creates the immutable annotated tag
// promoted-v<version> there (the only rollback route users are given) and marks the candidate's
// GitHub release as latest, no longer a prerelease. An existing promoted tag at another commit,
// or a lightweight one, is refused before anything changes. A retry finds release already at
// the candidate and finishes whichever of those steps is missing; the release is marked latest
// only while release still points at the candidate.
//
//   REQUIRED_CHECKS=$'repo checks\nplugins (ubuntu-latest)' node scripts/promote.mjs v0.2.0
//
// REQUIRED_CHECKS holds one check name per line: matrix job names contain commas.
import { pathToFileURL } from "node:url";
import { checkProof, piExtensionNames } from "./check-release-proof.mjs";
import { commitOf, jsonAt, makeRunner, must, PLACEHOLDER_VERSION, promotedTag, SEMVER } from "./release-lib.mjs";
import { promotedManifests } from "./sync-plugin-version.mjs";

/** The remote release branch's commit, read from the remote itself, or undefined. */
function remoteHead(run, remote, branch) {
  const out = must(run, "git", ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  return out ? out.split(/\s+/)[0] : undefined;
}

/** What the candidate declares, read from its commit. */
export function candidate(run, tag) {
  const sha = commitOf(run, `refs/tags/${tag}`);
  if (!sha) throw new Error(`tag ${tag} does not exist`);
  const pkg = jsonAt(run, sha, "package.json");
  const version = pkg.version;
  if (!SEMVER.test(String(version)) || tag !== `v${version}`) {
    throw new Error(`tag ${tag} does not match its package.json version ${version}`);
  }
  if (version === PLACEHOLDER_VERSION) throw new Error(`${tag} is the unreleased placeholder; it is never promoted`);
  const marketplace = jsonAt(run, sha, ".claude-plugin/marketplace.json");
  if (marketplace.metadata?.version !== version) throw new Error(`marketplace metadata.version at ${tag} is not ${version}`);
  const plugins = promotedManifests(marketplace);
  for (const { name, path } of plugins) {
    if (jsonAt(run, sha, path).version !== version) throw new Error(`${name} at ${tag} is not version ${version}`);
  }
  let extensions;
  try {
    extensions = piExtensionNames(pkg);
  } catch (e) {
    throw new Error(`${tag}: ${e.message}`);
  }
  return { sha, version, plugins: plugins.map((p) => p.name), extensions };
}

/**
 * The promoted tag on the remote: undefined when absent, else the commit it names. A lightweight
 * tag (no peeled `^{}` line) or one at another commit throws: promoted tags are never moved.
 */
function remotePromotedTag(run, remote, tag, sha) {
  const lines = must(run, "git", ["ls-remote", "--tags", remote]).split("\n").filter(Boolean).map((l) => l.split(/\s+/));
  const direct = lines.find(([, ref]) => ref === `refs/tags/${tag}`);
  if (!direct) return undefined;
  const peeled = lines.find(([, ref]) => ref === `refs/tags/${tag}^{}`);
  if (!peeled) throw new Error(`${tag} exists but is not an annotated tag; nothing changed`);
  if (peeled[0] !== sha) throw new Error(`${tag} already names ${peeled[0]}, not ${sha}; promoted tags are never moved; nothing changed`);
  return sha;
}

export function promote({ run, root, tag, ciPassed, remote = "origin", branch = "release", beforePush, beforeTag, beforeRelease }) {
  must(run, "git", ["fetch", "--force", "--tags", remote]);
  const c = candidate(run, tag);
  if (!ciPassed(c.sha)) throw new Error(`required CI checks have not all passed at ${c.sha}`);
  const proof = checkProof(root, c);
  if (proof.length) throw new Error(`E1a proof for ${c.version} is not a complete pass:\n  ${proof.join("\n  ")}`);
  const ptag = promotedTag(c.version);
  // Preflight: a conflicting promoted tag refuses before release moves.
  const tagged = remotePromotedTag(run, remote, ptag, c.sha);

  const old = remoteHead(run, remote, branch);
  let status = "unchanged";
  if (old !== c.sha) {
    if (old) {
      must(run, "git", ["fetch", remote, `refs/heads/${branch}`]);
      const oldVersion = jsonAt(run, old, "package.json").version;
      if (oldVersion === c.version) {
        throw new Error(`${branch} already holds version ${oldVersion} at ${old}; a different commit under the same version would split users`);
      }
      if (run("git", ["merge-base", "--is-ancestor", old, c.sha]).code !== 0) {
        throw new Error(`${branch} at ${old} is not an ancestor of ${c.sha}; promotion only fast-forwards`);
      }
    }
    beforePush?.();
    const lease = `--force-with-lease=refs/heads/${branch}:${old ?? ""}`;
    const pushed = run("git", ["push", lease, remote, `${c.sha}:refs/heads/${branch}`]);
    if (pushed.code !== 0) {
      throw new Error(`${branch} moved since it was verified at ${old ?? "(absent)"}; nothing changed. ${pushed.stderr}`);
    }
    status = "promoted";
  }

  beforeTag?.();
  let tagStatus = "exists";
  if (!tagged) {
    must(run, "git", ["tag", "-f", "-a", ptag, c.sha, "-m", `context-economy ${ptag}`]);
    const pushed = run("git", ["push", remote, `refs/tags/${ptag}`]);
    // A concurrent run may have pushed it: accept only the same annotated tag at the same commit.
    if (pushed.code !== 0 && !remotePromotedTag(run, remote, ptag, c.sha)) {
      throw new Error(`could not push ${ptag}: ${pushed.stderr}`);
    }
    tagStatus = "created";
  }

  beforeRelease?.();
  // Never mark an older candidate latest after a newer promotion moved release on.
  const now = remoteHead(run, remote, branch);
  if (now !== c.sha) throw new Error(`${branch} is at ${now ?? "(absent)"}, not ${c.sha}; release status left unchanged`);
  must(run, "gh", ["release", "edit", tag, "--prerelease=false", "--latest"]);
  return { ...c, status, old, promotedTag: ptag, tagStatus, release: "latest" };
}

/** Every required check run at `sha` completed successfully. No required checks: refuse. */
/** Check names, one per line. Matrix job names can contain commas, such as `job (ubuntu-latest, 3.10)`. */
export const requiredChecks = (text) => (text ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

export function ciPassedViaGh(run, repo, required) {
  return (sha) => {
    if (!repo || !required.length) return false;
    const r = run("gh", ["api", "--paginate", `repos/${repo}/commits/${sha}/check-runs`, "--jq", ".check_runs[] | [.name, .status, .conclusion] | @tsv"]);
    if (r.code !== 0) return false;
    const runs = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t"));
    return required.every((name) => {
      const mine = runs.filter(([n]) => n === name);
      return mine.length > 0 && mine.every(([, status, conclusion]) => status === "completed" && conclusion === "success");
    });
  };
}

/** The CLI, with its environment and runner injectable for tests. */
export function main([tag], { env = process.env, root = process.cwd(), run = makeRunner(root), log = console } = {}) {
  if (!tag) {
    log.error("usage: promote.mjs <tag>");
    return 2;
  }
  const required = requiredChecks(env.REQUIRED_CHECKS);
  try {
    const r = promote({ run, root, tag, ciPassed: ciPassedViaGh(run, env.GITHUB_REPOSITORY, required) });
    log.log(`${r.status === "unchanged" ? `release already at ${tag} (${r.sha})` : `release moved ${r.old ?? "(new)"} -> ${r.sha} (${tag})`}; ${r.promotedTag} ${r.tagStatus}; ${tag} marked latest`);
    return 0;
  } catch (e) {
    log.error(`promote: ${e.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
