// SPDX-License-Identifier: Apache-2.0

// Test fixture: a throwaway marketplace repository with a local bare remote. Real git, no network.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeRunner, must } from "./release-lib.mjs";

export const PLUGINS = ["second-plugin", "tool-gateway", "third-plugin"];
export const PI_EXTENSIONS = ["second-plugin", "tool-gateway"];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

export function writeJson(root, rel, value) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + "\n");
}

export const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

/** A repo at `version`, everything in sync, committed on main and pushed to `remote`. */
export function fixtureRepo(version = "0.1.0") {
  const base = mkdtempSync(join(tmpdir(), "release-fixture-"));
  const root = join(base, "work");
  const remote = join(base, "remote.git");
  mkdirSync(root);
  const run = makeRunner(root, GIT_ENV);
  must(makeRunner(base, GIT_ENV), "git", ["init", "-q", "--bare", "-b", "main", remote]);
  writeJson(root, "package.json", {
    name: "fixture", version, private: true,
    pi: { extensions: PI_EXTENSIONS.map((e) => `./extensions/${e}/index.ts`) },
  });
  writeJson(root, ".claude-plugin/marketplace.json", {
    name: "context-economy",
    owner: { name: "t" },
    metadata: { description: "d", version },
    plugins: PLUGINS.map((name) => ({ name, source: `./plugins/${name}`, description: name })),
  });
  for (const name of PLUGINS) writeJson(root, `plugins/${name}/.claude-plugin/plugin.json`, { name, version });
  must(run, "git", ["init", "-q", "-b", "main"]);
  must(run, "git", ["remote", "add", "origin", remote]);
  commitAll(run, `v${version}`);
  must(run, "git", ["push", "-q", "origin", "main"]);
  return { base, root, remote, run, env: GIT_ENV };
}

export function commitAll(run, message) {
  must(run, "git", ["add", "-A"]);
  must(run, "git", ["commit", "-q", "--allow-empty", "-m", message]);
  return must(run, "git", ["rev-parse", "HEAD"]);
}

/** Sets every manifest to `version` and commits; returns the commit. */
export function bumpAndCommit(fx, version) {
  writeJson(fx.root, "package.json", { ...readJson(fx.root, "package.json"), version });
  const m = readJson(fx.root, ".claude-plugin/marketplace.json");
  m.metadata.version = version;
  writeJson(fx.root, ".claude-plugin/marketplace.json", m);
  for (const name of PLUGINS) writeJson(fx.root, `plugins/${name}/.claude-plugin/plugin.json`, { name, version });
  return commitAll(fx.run, `version ${version}`);
}

export function tagAndPush(fx, tag, sha) {
  must(fx.run, "git", ["tag", "-a", tag, sha, "-m", tag]);
  must(fx.run, "git", ["push", "-q", "origin", `refs/tags/${tag}`]);
}

/** A complete passing E1a proof for `sha`. */
export function passingProof(version, sha) {
  const run = (platform) => ({
    platform,
    claude_code_version: "2.1.310",
    date: "2026-10-25",
    plugins: Object.fromEntries(PLUGINS.map((p) => [p, sha])),
    steps: { install: "pass", installed_commit: "pass", behavior: "pass", uninstall: "pass" },
    result: "pass",
    pi: {
      pi_version: "1.0.2",
      installed_commit: sha,
      extensions: [...PI_EXTENSIONS],
      steps: { install: "pass", installed_commit: "pass", behavior: "pass", uninstall: "pass" },
      result: "pass",
    },
  });
  return { version, tag: `v${version}`, candidate_sha: sha, runs: [run("macos-arm64"), run("linux-x86_64")] };
}

/**
 * `gh` replaced: records calls, answers `release view` from a set of existing releases, and keeps
 * each release's status (`prerelease`, `latest`) through `create` and `edit`. `failEdit` makes
 * every `release edit` fail, as an interrupted run would.
 */
export function fakeGh(run, releases = new Set(), { failEdit = false } = {}) {
  const calls = [];
  const status = new Map();
  const wrapped = (cmd, args) => {
    if (cmd !== "gh") return run(cmd, args);
    calls.push(args);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "release" && args[1] === "view") return { code: releases.has(args[2]) ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "release" && args[1] === "create") {
      releases.add(args[2]);
      status.set(args[2], { prerelease: args.includes("--prerelease"), latest: false });
      return ok;
    }
    if (args[0] === "release" && args[1] === "edit") {
      if (failEdit || !releases.has(args[2])) return { code: 1, stdout: "", stderr: "edit failed" };
      const latest = args.includes("--latest");
      if (latest) for (const s of status.values()) s.latest = false;
      status.set(args[2], { prerelease: !args.includes("--prerelease=false"), latest });
      return ok;
    }
    return { code: 1, stdout: "", stderr: "unexpected gh call" };
  };
  return { run: wrapped, calls, releases, status };
}
