#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// An E1a record counts only as a completed pass. A proof that exists but
// is partial or failed is refused. The record lives on main, a later commit than the tag it
// proves, so a tagged commit never has to contain its own test result.
//
// Each run also proves the Pi install of the same candidate: a `pi` block with the Pi
// version, the commit Pi installed (must be the candidate), exactly the candidate's Pi extensions
// (package.json `pi.extensions`), and every step passed.
//
//   node scripts/check-release-proof.mjs <version> <candidate sha> <plugin>... --pi <extension>...
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SHA40 } from "./release-lib.mjs";

export const PLATFORMS = ["macos-arm64", "linux-x86_64"];
export const STEPS = ["install", "installed_commit", "behavior", "uninstall"];

export const proofPath = (version) => `docs/release-proof/${version}.json`;

/**
 * Extension names from package.json `pi.extensions` (`./extensions/<name>/index.ts`). Fails
 * closed: a missing, non-array, empty or duplicated list throws, so a candidate can
 * never turn the Pi proof requirement off.
 */
export function piExtensionNames(pkg) {
  const paths = pkg?.pi?.extensions;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("package.json pi.extensions must list at least one ./extensions/<name>/index.ts");
  }
  const names = paths.map((p) => {
    const m = /^\.\/extensions\/([^/]+)\/index\.ts$/.exec(String(p));
    if (!m) throw new Error(`pi.extensions entry ${JSON.stringify(p)} is not ./extensions/<name>/index.ts`);
    return m[1];
  });
  const dup = names.find((n, k) => names.indexOf(n) !== k);
  if (dup) throw new Error(`pi.extensions lists ${dup} more than once`);
  return names;
}

/** Reasons a run's Pi block does not show a complete pass of the candidate. */
function piErrors(platform, pi, sha, extensions) {
  const errors = [];
  if (!pi || typeof pi !== "object") return [`${platform}: pi block missing`];
  if (typeof pi.pi_version !== "string" || !pi.pi_version) errors.push(`${platform}: pi.pi_version missing`);
  if (!SHA40.test(String(pi.installed_commit))) errors.push(`${platform}: pi.installed_commit is not a full 40-hex SHA`);
  else if (pi.installed_commit !== sha) errors.push(`${platform}: pi installed ${pi.installed_commit}, not ${sha}`);
  const got = Array.isArray(pi.extensions) ? pi.extensions : [];
  if (!Array.isArray(pi.extensions)) errors.push(`${platform}: pi.extensions missing`);
  for (const name of new Set(got)) {
    const n = got.filter((x) => x === name).length;
    if (n > 1) errors.push(`${platform}: pi extension ${name} listed ${n} times`);
    if (!extensions.includes(name)) errors.push(`${platform}: unexpected pi extension ${name}`);
  }
  for (const name of extensions) if (!got.includes(name)) errors.push(`${platform}: pi extension ${name} missing`);
  for (const step of STEPS) {
    if (pi.steps?.[step] !== "pass") errors.push(`${platform}: pi step ${step} is ${pi.steps?.[step] ?? "missing"}`);
  }
  if (pi.result !== "pass") errors.push(`${platform}: pi result is ${pi.result ?? "missing"}`);
  return errors;
}

/** Every reason the proof does not show a complete pass; empty when it does. */
export function proofErrors(proof, { version, sha, plugins, extensions }) {
  const errors = [];
  // The Pi proof is always required: no expected extensions is a caller error, never a waiver.
  if (!Array.isArray(extensions) || extensions.length === 0) return ["no Pi extensions expected; the Pi proof cannot be checked"];
  if (!proof || typeof proof !== "object") return ["proof is not a JSON object"];
  if (proof.version !== version) errors.push(`version is ${proof.version}, want ${version}`);
  if (proof.tag !== `v${version}`) errors.push(`tag is ${proof.tag}, want v${version}`);
  if (!SHA40.test(String(proof.candidate_sha))) errors.push("candidate_sha is not a full 40-hex SHA");
  else if (proof.candidate_sha !== sha) errors.push(`candidate_sha ${proof.candidate_sha} is not the tag's commit ${sha}`);
  const runs = Array.isArray(proof.runs) ? proof.runs : [];
  if (!Array.isArray(proof.runs)) errors.push("runs is missing");
  for (const platform of PLATFORMS) {
    const found = runs.filter((r) => r?.platform === platform);
    if (found.length !== 1) {
      errors.push(`${platform}: ${found.length} runs, want exactly 1`);
      continue;
    }
    const run = found[0];
    if (typeof run.claude_code_version !== "string" || !run.claude_code_version) errors.push(`${platform}: claude_code_version missing`);
    if (typeof run.date !== "string" || !run.date) errors.push(`${platform}: date missing`);
    for (const plugin of plugins) {
      const got = run.plugins?.[plugin];
      if (got === undefined) errors.push(`${platform}: plugin ${plugin} missing`);
      else if (got !== sha) errors.push(`${platform}: plugin ${plugin} installed at ${got}, not ${sha}`);
    }
    for (const step of STEPS) {
      if (run.steps?.[step] !== "pass") errors.push(`${platform}: step ${step} is ${run.steps?.[step] ?? "missing"}`);
    }
    if (run.result !== "pass") errors.push(`${platform}: result is ${run.result ?? "missing"}`);
    errors.push(...piErrors(platform, run.pi, sha, extensions));
  }
  for (const r of runs) {
    if (!PLATFORMS.includes(r?.platform)) errors.push(`unsupported platform ${r?.platform}`);
  }
  return errors;
}

/** Reads the proof from the trusted checkout at `root`. Missing or unparsable is an error. */
export function checkProof(root, expected) {
  let proof;
  try {
    proof = JSON.parse(readFileSync(join(root, proofPath(expected.version)), "utf8"));
  } catch (e) {
    return [`${proofPath(expected.version)}: ${e.code === "ENOENT" ? "missing" : e.message}`];
  }
  return proofErrors(proof, expected);
}

function main([version, sha, ...rest]) {
  const at = rest.indexOf("--pi");
  const plugins = at < 0 ? rest : rest.slice(0, at);
  const extensions = at < 0 ? [] : rest.slice(at + 1);
  if (!version || !sha || !plugins.length || !extensions.length) {
    console.error("usage: check-release-proof.mjs <version> <candidate sha> <plugin>... --pi <extension>...");
    return 2;
  }
  const errors = checkProof(process.cwd(), { version, sha, plugins, extensions });
  if (errors.length) {
    console.error(`E1a proof for ${version} is not a complete pass:\n  ${errors.join("\n  ")}`);
    return 1;
  }
  console.log(`E1a proof for ${version} at ${sha}: complete pass`);
  return 0;
}

export { main };

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
