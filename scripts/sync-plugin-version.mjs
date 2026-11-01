#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// One version, held in the root package.json, written into every promoted plugin's
// plugin.json and the marketplace's metadata.version. Never into a marketplace entry's
// `version`: the host reads plugin.json first and `validate` warns when both are set.
//
//   node scripts/sync-plugin-version.mjs           write
//   node scripts/sync-plugin-version.mjs --check   exit 1 on drift, write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MARKETPLACE = ".claude-plugin/marketplace.json";

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const writeJson = (root, rel, value) =>
  writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + "\n");

/** Promoted plugins are the marketplace entries; each relative source holds a plugin.json. */
export function promotedManifests(marketplace) {
  return marketplace.plugins.map((entry) => {
    if (typeof entry.source !== "string" || !entry.source.startsWith("./")) {
      throw new Error(`${entry.name}: only relative-path sources are synced`);
    }
    return { name: entry.name, path: `${entry.source.slice(2)}/.claude-plugin/plugin.json` };
  });
}

/** Every difference between the root version and the manifests, as human-readable lines. */
export function drift(root) {
  return driftOf((rel) => readJson(root, rel));
}

/**
 * The same check over any snapshot: `read(rel)` returns a file's parsed JSON and throws if it
 * is missing. Release tooling passes a reader over one commit (`git show`), never the worktree.
 */
export function driftOf(read) {
  const version = read("package.json").version;
  const marketplace = read(MARKETPLACE);
  const out = [];
  if (marketplace.metadata?.version !== version) {
    out.push(`${MARKETPLACE} metadata.version is ${marketplace.metadata?.version} (want ${version})`);
  }
  if (marketplace.version !== undefined) out.push(`${MARKETPLACE} sets top-level version; use metadata.version`);
  for (const entry of marketplace.plugins) {
    if (entry.version !== undefined) out.push(`${MARKETPLACE} entry ${entry.name} sets version; remove it`);
  }
  for (const { name, path } of promotedManifests(marketplace)) {
    const manifest = read(path);
    if (manifest.name !== name) out.push(`${path} name is ${manifest.name} (entry ${name})`);
    if (manifest.version !== version) out.push(`${path} version is ${manifest.version} (want ${version})`);
  }
  return { version, lines: out };
}

export function sync(root) {
  const version = readJson(root, "package.json").version;
  const marketplace = readJson(root, MARKETPLACE);
  delete marketplace.version;
  for (const entry of marketplace.plugins) delete entry.version;
  marketplace.metadata = { ...marketplace.metadata, version };
  writeJson(root, MARKETPLACE, marketplace);
  for (const { path } of promotedManifests(marketplace)) {
    writeJson(root, path, { ...readJson(root, path), version });
  }
  return version;
}

function main(argv) {
  const root = process.cwd();
  if (argv.includes("--check")) {
    const { version, lines } = drift(root);
    if (lines.length) {
      console.error(`version drift from package.json ${version}:\n  ${lines.join("\n  ")}`);
      return 1;
    }
    console.log(`versions in sync at ${version}`);
    return 0;
  }
  console.log(`synced plugin versions to ${sync(root)}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
