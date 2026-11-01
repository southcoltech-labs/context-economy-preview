// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { drift, sync } from "./sync-plugin-version.mjs";
import { fixtureRepo, PLUGINS, readJson, writeJson } from "./test-fixture.mjs";

test("in-sync fixture reports no drift", () => {
  const { root } = fixtureRepo();
  assert.deepEqual(drift(root).lines, []);
});

test("a version bump in package.json is drift until synced, then every manifest follows", () => {
  const { root } = fixtureRepo();
  writeJson(root, "package.json", { ...readJson(root, "package.json"), version: "0.2.0" });
  assert.equal(drift(root).lines.length, 1 + PLUGINS.length);
  assert.equal(sync(root), "0.2.0");
  assert.deepEqual(drift(root).lines, []);
  assert.equal(readJson(root, ".claude-plugin/marketplace.json").metadata.version, "0.2.0");
  for (const p of PLUGINS) assert.equal(readJson(root, `plugins/${p}/.claude-plugin/plugin.json`).version, "0.2.0");
});

test("an entry version or a top-level marketplace version is drift, and sync removes it", () => {
  const { root } = fixtureRepo();
  const m = readJson(root, ".claude-plugin/marketplace.json");
  m.version = "0.1.0";
  m.plugins[1].version = "0.1.0";
  writeJson(root, ".claude-plugin/marketplace.json", m);
  const lines = drift(root).lines;
  assert.ok(lines.some((l) => l.includes("top-level version")));
  assert.ok(lines.some((l) => l.includes("entry tool-gateway sets version")));
  sync(root);
  const after = readJson(root, ".claude-plugin/marketplace.json");
  assert.equal(after.version, undefined);
  assert.equal(after.plugins[1].version, undefined);
  assert.deepEqual(drift(root).lines, []);
});

test("a manifest whose name differs from its entry is drift", () => {
  const { root } = fixtureRepo();
  writeJson(root, "plugins/third-plugin/.claude-plugin/plugin.json", { name: "other", version: "0.1.0" });
  assert.ok(drift(root).lines.some((l) => l.includes("name is other")));
});

test("an unpromoted plugin is left alone", () => {
  const { root } = fixtureRepo();
  writeJson(root, "plugins/recap/.claude-plugin/plugin.json", { name: "recap", version: "0.0.9" });
  writeJson(root, "package.json", { ...readJson(root, "package.json"), version: "0.2.0" });
  sync(root);
  assert.equal(readJson(root, "plugins/recap/.claude-plugin/plugin.json").version, "0.0.9");
});
