// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main } from "./e1b-data.mjs";

const CONFIG_TEXT = '{\n  "rtk": { "path": "/opt/rtk-0.47.0/rtk" }\n}\n';

/** A HOME with a Claude and a Pi ledger and a config naming rtk.path. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "e1b-home-"));
  const base = join(dir, ".claude/context-economy");
  const ledger = join(base, "gateway-ledger/s-1-0.jsonl");
  const piLedger = join(base, "gateway-ledger-pi/s-2-0.jsonl");
  for (const f of [ledger, piLedger]) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '{"row":1}\n{"row":2}\n');
  }
  const config = join(base, "config.json");
  writeFileSync(config, CONFIG_TEXT);
  const snap = join(dir, "snap.json");
  const logs = [];
  const run = (cmd, file = snap) => main([cmd, file], { env: { HOME: dir }, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
  return { dir, base, ledger, piLedger, config, snap, run, logs };
}

test("unchanged data, appended rows and new ledger files pass", () => {
  const h = home();
  assert.equal(h.run("snapshot"), 0);
  assert.equal(Buffer.from(JSON.parse(readFileSync(h.snap, "utf8")).config, "base64").toString("utf8"), CONFIG_TEXT);
  assert.equal(h.run("check"), 0, h.logs.join("\n"));
  appendFileSync(h.ledger, '{"row":3}\n');
  appendFileSync(h.piLedger, '{"row":3}\n');
  writeFileSync(join(h.base, "gateway-ledger/s-3-0.jsonl"), '{"row":1}\n');
  assert.equal(h.run("check"), 0, h.logs.join("\n"));
  assert.match(h.logs.at(-1), /all 2 ledger files and config.json survive/);
});

test("a lost, rewritten or removed ledger fails, on either host", () => {
  for (const [change, message] of [
    [(h) => writeFileSync(h.ledger, '{"row":1}\n'), /gateway-ledger\/s-1-0.jsonl lost or changed rows \(had 2, has 1\)/],
    [(h) => writeFileSync(h.piLedger, '{"row":1}\n{"row":9}\n'), /gateway-ledger-pi\/s-2-0.jsonl lost or changed rows/],
    [(h) => rmSync(h.piLedger), /gateway-ledger-pi\/s-2-0.jsonl missing/],
  ]) {
    const h = home();
    h.run("snapshot");
    change(h);
    assert.equal(h.run("check"), 1);
    assert.match(h.logs.at(-1), message);
  }
});

test("config.json must stay byte-identical", () => {
  for (const [change, message] of [
    [(h) => rmSync(h.config), /config.json missing/],
    [(h) => writeFileSync(h.config, CONFIG_TEXT.replace("\n}", "}")), /config.json changed/],
    [(h) => writeFileSync(h.config, CONFIG_TEXT.replace("0.47.0", "0.48.0")), /config.json changed/],
  ]) {
    const h = home();
    h.run("snapshot");
    change(h);
    assert.equal(h.run("check"), 1);
    assert.match(h.logs.at(-1), message);
  }
});

test("a thin baseline is refused at snapshot, and a thin snapshot file fails check", () => {
  const cases = [
    [(h) => rmSync(h.ledger), /no rows in gateway-ledger: /],
    [(h) => writeFileSync(h.piLedger, ""), /no rows in gateway-ledger-pi: /],
    [(h) => rmSync(h.config), /no config.json: /],
    [(h) => writeFileSync(h.config, '{"python":{"path":"/x"}}\n'), /config.json has no rtk.path: /],
    [(h) => writeFileSync(h.config, '{"rtk":{"path":""}}\n'), /config.json has no rtk.path: /],
    [(h) => writeFileSync(h.config, "not json"), /config.json has no rtk.path: /],
  ];
  for (const [thin, message] of cases) {
    const h = home();
    thin(h);
    assert.equal(h.run("snapshot"), 1);
    assert.match(h.logs.at(-1), message);
    assert.ok(!existsSync(h.snap), "nothing written");
  }
  // A snapshot file edited down to no logs, or no config, cannot pass check.
  for (const [edit, message] of [
    [(s) => ({ ...s, logs: {} }), /snapshot has no rows in gateway-ledger:/],
    [(s) => ({ ...s, config: null }), /snapshot has no config.json:/],
  ]) {
    const h = home();
    h.run("snapshot");
    writeFileSync(h.snap, JSON.stringify(edit(JSON.parse(readFileSync(h.snap, "utf8")))));
    assert.equal(h.run("check"), 1);
    assert.match(h.logs.at(-1), message);
  }
});

test("bad use is refused; ids is no longer a command", () => {
  const h = home();
  h.run("snapshot");
  const quiet = { log: { log() {}, error() {} } };
  assert.equal(main(["ids", h.snap], quiet), 2);
  assert.equal(main(["diff", h.snap], quiet), 2);
  assert.equal(main(["check", join(h.dir, "none.json")], quiet), 2);
});
