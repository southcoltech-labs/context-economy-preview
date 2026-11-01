// SPDX-License-Identifier: Apache-2.0

// Shared by the release scripts. Every external command goes through a runner so tests can
// drive real git against local repositories and replace `gh`.
import { execFileSync } from "node:child_process";

/** Runs a command; returns { code, stdout, stderr }. Never throws on a non-zero exit. */
export function makeRunner(cwd, env = process.env) {
  return (cmd, args) => {
    try {
      const stdout = execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stdout: stdout.trim(), stderr: "" };
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? e.message).trim() };
    }
  };
}

/** Runs and requires success. */
export function must(run, cmd, args) {
  const r = run(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** The commit a ref names, or undefined. Peels annotated tags. */
export function commitOf(run, ref) {
  const r = run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 && r.stdout ? r.stdout : undefined;
}

/** A file's text at a commit, read with git (never checked out or executed), or undefined. */
export function showAt(run, sha, path) {
  const r = run("git", ["show", `${sha}:${path}`]);
  return r.code === 0 ? r.stdout : undefined;
}

export function jsonAt(run, sha, path) {
  const text = showAt(run, sha, path);
  if (text === undefined) throw new Error(`${path} missing at ${sha}`);
  return JSON.parse(text);
}

export const SHA40 = /^[0-9a-f]{40}$/;
export const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * The unreleased placeholder every manifest holds until the first version PR: tagging skips it and promotion refuses it.
 */
export const PLACEHOLDER_VERSION = "0.0.0";

/** The immutable tag promotion creates for `version`; rollback names only these. */
export const promotedTag = (version) => `promoted-v${version}`;
