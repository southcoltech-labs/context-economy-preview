#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// E1b data check: proves the user's data survives update, rollback and uninstall (E1b steps 4–6),
// for what tool-gateway keeps. `snapshot` after E1b step 1 writes what is there,
// and refuses a baseline that would prove little: no row in either gateway ledger, or no
// `config.json` naming `rtk.path`. `check` after each later step compares the live data with it:
//   - every ledger file still begins with the lines it had (rows are only appended);
//   - `config.json` is byte-identical.
// New rows and files are allowed. It reads only; it never writes the data folders.
//
//   node scripts/e1b-data.mjs snapshot <file>
//   node scripts/e1b-data.mjs check <file>
//
// Data location: $HOME/.claude/context-economy.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LOGS = ["gateway-ledger", "gateway-ledger-pi"];
const CONFIG = "config.json";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const files = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort() : []);

/** Ledger files (a hash per line) and the config's bytes (base64) under the `context-economy` folder `base`. */
export function snapshot(base) {
  const logs = {};
  for (const dir of LOGS) {
    for (const name of files(join(base, dir)).filter((n) => n.endsWith(".jsonl"))) {
      logs[`${dir}/${name}`] = readFileSync(join(base, dir, name), "utf8").split("\n").filter(Boolean).map(hash);
    }
  }
  const config = existsSync(join(base, CONFIG)) ? readFileSync(join(base, CONFIG)).toString("base64") : null;
  return { logs, config };
}

/** Why `snap` is too thin to be a baseline; empty when both ledgers have rows and the config names `rtk.path`. */
export function baselineErrors(snap) {
  const errors = [];
  for (const dir of LOGS) {
    const rows = Object.entries(snap.logs ?? {}).filter(([f]) => f.startsWith(`${dir}/`)).reduce((n, [, lines]) => n + lines.length, 0);
    if (rows === 0) errors.push(`no rows in ${dir}: make a shell call on that host first`);
  }
  if (typeof snap.config !== "string") {
    errors.push(`no ${CONFIG}: configure RTK first`);
  } else {
    let path;
    try {
      path = JSON.parse(Buffer.from(snap.config, "base64").toString("utf8"))?.rtk?.path;
    } catch {
      // Reported below as a missing rtk.path.
    }
    if (typeof path !== "string" || path === "") errors.push(`${CONFIG} has no rtk.path: configure RTK first`);
  }
  return errors;
}

/** Every way `now` lost or changed what `then` held; empty when all of it survives. */
export function compare(then, now) {
  const errors = [];
  for (const [file, lines] of Object.entries(then.logs ?? {})) {
    const got = now.logs[file];
    if (!got) errors.push(`${file} missing`);
    else if (lines.some((h, k) => got[k] !== h)) errors.push(`${file} lost or changed rows (had ${lines.length}, has ${got.length})`);
  }
  if (typeof then.config === "string") {
    if (now.config === null) errors.push(`${CONFIG} missing`);
    else if (now.config !== then.config) errors.push(`${CONFIG} changed`);
  }
  return [...baselineErrors(then).map((e) => `snapshot has ${e}`), ...errors];
}

export function main([command, file], { env = process.env, log = console } = {}) {
  const base = join(env.HOME || homedir(), ".claude", "context-economy");
  if (!["snapshot", "check"].includes(command) || !file) {
    log.error("usage: e1b-data.mjs snapshot|check <file>");
    return 2;
  }
  if (command === "snapshot") {
    const snap = snapshot(base);
    const thin = baselineErrors(snap);
    if (thin.length) {
      log.error(`not a baseline, nothing written:\n  ${thin.join("\n  ")}`);
      return 1;
    }
    writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
    log.log(`${file}: ${Object.keys(snap.logs).length} ledger files and ${CONFIG}`);
    return 0;
  }
  let then;
  try {
    then = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    log.error(`e1b-data: ${file}: ${e.message}`);
    return 2;
  }
  const errors = compare(then, snapshot(base));
  if (errors.length) {
    log.error(`data from the snapshot did not survive:\n  ${errors.join("\n  ")}`);
    return 1;
  }
  log.log(`all ${Object.keys(then.logs).length} ledger files and ${CONFIG} survive`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
