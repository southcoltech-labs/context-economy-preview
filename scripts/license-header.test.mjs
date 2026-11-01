// SPDX-License-Identifier: Apache-2.0

// Every source file carries the SPDX tag for the project's license, after a shebang if it has one.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /\.(ts|tsx|mjs|js|cjs|sh|ya?ml)$/;
const SKIP = new Set(["node_modules", ".claude-plugin", ".git"]);

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (SOURCE.test(entry.name)) yield path;
  }
}

test("every source file starts with the SPDX tag", () => {
  const files = ["scripts", "plugins", "extensions", ".github"].flatMap(d => [...sources(join(ROOT, d))]);
  assert.ok(files.length > 40, `found only ${files.length} source files`);
  const missing = files.filter(file => {
    const lines = readFileSync(file, "utf8").split("\n");
    const first = lines[0].startsWith("#!") ? lines[1] : lines[0];
    return !/^(\/\/|#) SPDX-License-Identifier: Apache-2\.0$/.test(first);
  });
  assert.deepEqual(missing.map(f => relative(ROOT, f)), []);
});
