// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkProof, main, piExtensionNames, proofErrors } from "./check-release-proof.mjs";
import { passingProof, PI_EXTENSIONS, PLUGINS, writeJson } from "./test-fixture.mjs";

const SHA = "a".repeat(40);
const expected = { version: "0.2.0", sha: SHA, plugins: PLUGINS, extensions: PI_EXTENSIONS };
const errorsAfter = (mutate) => {
  const p = passingProof("0.2.0", SHA);
  mutate(p);
  return proofErrors(p, expected);
};

test("a complete passing proof has no errors", () => {
  assert.deepEqual(proofErrors(passingProof("0.2.0", SHA), expected), []);
});

test("a missing proof file is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "proof-"));
  assert.match(checkProof(root, expected)[0], /missing/);
});

test("a proof read from the checkout is validated", () => {
  const root = mkdtempSync(join(tmpdir(), "proof-"));
  writeJson(root, "docs/release-proof/0.2.0.json", passingProof("0.2.0", SHA));
  assert.deepEqual(checkProof(root, expected), []);
});

test("wrong, short or missing candidate SHA is refused", () => {
  assert.ok(errorsAfter((p) => (p.candidate_sha = "b".repeat(40))).some((e) => /not the tag's commit/.test(e)));
  assert.ok(errorsAfter((p) => (p.candidate_sha = "a".repeat(12))).some((e) => /40-hex/.test(e)));
  assert.ok(errorsAfter((p) => delete p.candidate_sha).some((e) => /40-hex/.test(e)));
});

test("wrong version or tag is refused", () => {
  assert.ok(errorsAfter((p) => (p.version = "0.1.9")).length > 0);
  assert.ok(errorsAfter((p) => (p.tag = "v0.1.9")).length > 0);
});

test("a missing or duplicated platform is refused", () => {
  assert.ok(errorsAfter((p) => p.runs.pop()).some((e) => /linux-x86_64: 0 runs/.test(e)));
  assert.ok(errorsAfter((p) => p.runs.push({ ...p.runs[0] })).some((e) => /macos-arm64: 2 runs/.test(e)));
  assert.ok(errorsAfter((p) => delete p.runs).some((e) => /runs is missing/.test(e)));
  assert.ok(errorsAfter((p) => p.runs.push({ platform: "windows-x86_64" })).some((e) => /unsupported platform/.test(e)));
});

test("a missing plugin, or a plugin at another commit, is refused", () => {
  assert.ok(errorsAfter((p) => delete p.runs[0].plugins["tool-gateway"]).some((e) => /tool-gateway missing/.test(e)));
  assert.ok(errorsAfter((p) => (p.runs[1].plugins["third-plugin"] = "c".repeat(40))).some((e) => /third-plugin installed at/.test(e)));
});

test("any step not passed, or a failed or missing result, is refused", () => {
  assert.ok(errorsAfter((p) => (p.runs[0].steps.uninstall = "fail")).some((e) => /step uninstall is fail/.test(e)));
  assert.ok(errorsAfter((p) => delete p.runs[1].steps.behavior).some((e) => /step behavior is missing/.test(e)));
  assert.ok(errorsAfter((p) => (p.runs[0].result = "partial")).some((e) => /result is partial/.test(e)));
  assert.ok(errorsAfter((p) => delete p.runs[1].result).some((e) => /result is missing/.test(e)));
});

test("missing host version or date is refused", () => {
  assert.ok(errorsAfter((p) => delete p.runs[0].claude_code_version).length > 0);
  assert.ok(errorsAfter((p) => (p.runs[1].date = "")).length > 0);
});

test("a non-object proof is refused", () => {
  assert.deepEqual(proofErrors(null, expected), ["proof is not a JSON object"]);
});

// The Pi install of the same candidate, fail closed.

const piCases = {
  "missing pi block": (r) => { delete r.pi; },
  "missing pi version": (r) => { delete r.pi.pi_version; },
  "short installed commit": (r) => { r.pi.installed_commit = "abc123"; },
  "wrong installed commit": (r) => { r.pi.installed_commit = "b".repeat(40); },
  "missing extensions list": (r) => { delete r.pi.extensions; },
  "missing extension": (r) => { r.pi.extensions = ["second-plugin"]; },
  "duplicate extension": (r) => { r.pi.extensions = ["second-plugin", "tool-gateway", "tool-gateway"]; },
  "unexpected extension": (r) => { r.pi.extensions.push("context-bar"); },
  "failed step": (r) => { r.pi.steps.behavior = "fail"; },
  "missing step": (r) => { delete r.pi.steps.uninstall; },
  "failed result": (r) => { r.pi.result = "fail"; },
  "missing result": (r) => { delete r.pi.result; },
};
for (const platform of ["macos-arm64", "linux-x86_64"]) {
  for (const [label, mutate] of Object.entries(piCases)) {
    test(`${platform}: ${label} in the pi block is refused`, () => {
      const errors = errorsAfter((p) => mutate(p.runs.find((r) => r.platform === platform)));
      assert.ok(errors.length > 0, label);
      assert.ok(errors.every((e) => e.startsWith(`${platform}: `)), errors.join("; "));
    });
  }
}

test("piExtensionNames reads ./extensions/<name>/index.ts and fails closed on anything else", () => {
  assert.deepEqual(piExtensionNames({ pi: { extensions: ["./extensions/second-plugin/index.ts", "./extensions/tool-gateway/index.ts"] } }), PI_EXTENSIONS);
  // A candidate cannot switch the Pi proof off.
  for (const pkg of [{}, { pi: {} }, { pi: { extensions: "./extensions/x/index.ts" } }, { pi: { extensions: [] } }, null]) {
    assert.throws(() => piExtensionNames(pkg), /must list at least one/, JSON.stringify(pkg));
  }
  assert.throws(() => piExtensionNames({ pi: { extensions: ["./extensions/*.ts"] } }), /not \.\/extensions/);
  assert.throws(() => piExtensionNames({ pi: { extensions: ["./extensions/a/index.ts", "./extensions/a/index.ts"] } }), /more than once/);
});

test("no expected Pi extensions is an error, never a waiver of the Pi proof", () => {
  const proof = passingProof("0.2.0", SHA);
  for (const extensions of [undefined, [], "second-plugin"]) {
    const errors = proofErrors(proof, { version: "0.2.0", sha: SHA, plugins: PLUGINS, extensions });
    assert.deepEqual(errors, ["no Pi extensions expected; the Pi proof cannot be checked"], String(extensions));
  }
});

test("both platforms' pi blocks missing: refused once per platform", () => {
  const errors = errorsAfter((p) => { for (const r of p.runs) delete r.pi; });
  assert.deepEqual(errors, ["macos-arm64: pi block missing", "linux-x86_64: pi block missing"]);
});

test("CLI: --pi with at least one extension is required", () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-cli-"));
  writeJson(dir, "docs/release-proof/0.2.0.json", passingProof("0.2.0", SHA));
  const cli = (args) => {
    const errors = []
    const cwd = process.cwd();
    process.chdir(dir);
    const origError = console.error, origLog = console.log;
    console.error = (m) => errors.push(m); console.log = () => {};
    try { return { code: main(args), errors }; } finally { console.error = origError; console.log = origLog; process.chdir(cwd); }
  };
  assert.equal(cli(["0.2.0", SHA, ...PLUGINS]).code, 2);
  assert.equal(cli(["0.2.0", SHA, ...PLUGINS, "--pi"]).code, 2);
  assert.equal(cli(["0.2.0", SHA, ...PLUGINS, "--pi", ...PI_EXTENSIONS]).code, 0);
  writeJson(dir, "docs/release-proof/0.2.0.json", (() => { const p = passingProof("0.2.0", SHA); delete p.runs[0].pi; return p; })());
  assert.equal(cli(["0.2.0", SHA, ...PLUGINS, "--pi", ...PI_EXTENSIONS]).code, 1);
});

test("the repository's own package.json names exactly the published Pi extension", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(piExtensionNames(pkg), ["tool-gateway"]);
});
