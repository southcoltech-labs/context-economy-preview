// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "claude-code/testing";
import { gatewayConfig } from "./config.ts";
import { createTrust } from "./rtk-trust.ts";
import { trustedRewrite } from "./trusted-rewrite.ts";
import type { Ports } from "./types.ts";

const BIN = "/opt/rtk/bin/rtk";

/** A host whose process timeout does not hold: `rewrite` answers successfully after `rewriteMs`. */
function lateHost(rewriteMs: number): Ports {
  let now = 10_000;
  return {
    nowMs: () => now,
    status: () => undefined,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    writeFile: async () => undefined,
    run: async argv => {
      if (argv[0] === "/usr/bin/uname") return { exitCode: 0, stdout: "Darwin\n", stderr: "" };
      if (argv[0] === "/usr/bin/id") return { exitCode: 0, stdout: "501\n", stderr: "" };
      if (argv[0] === "/usr/bin/stat") return { exitCode: 0, stdout: "100755|501|1|42|1000|100|200\n", stderr: "" };
      if (argv[1] === "--version") return { exitCode: 0, stdout: "rtk 0.47.0\n", stderr: "" };
      now += rewriteMs;
      return { exitCode: 0, stdout: "rtk ls", stderr: "" };
    },
  };
}

const rewrite = (ports: Ports) => trustedRewrite({
  ports,
  cfg: gatewayConfig({ home: "/tmp/home", flag: undefined, host: "pi" }),
  trust: createTrust(),
  realPath: async () => BIN,
  envBin: () => BIN,
  readConfig: async () => undefined,
}, "ls");

test("a rewrite answered after the 1 s budget is not used: the original command runs", async () => {
  const r = await rewrite(lateHost(1500));
  expect(r).toMatchObject({ command: "ls", status: "error", reason: "rewrite_budget" });
});

test("the same rewrite answered in time is applied", async () => {
  const r = await rewrite(lateHost(10));
  expect(r).toMatchObject({ command: `'${BIN}' ls`, status: "applied" });
});

/** Resolves `value` after `ms` of real time: a read with no timeout of its own. */
const slow = <T>(ms: number, value: T) => () => new Promise<T>(r => setTimeout(() => r(value), ms));
const realHost = (): Ports => ({ ...lateHost(10), nowMs: () => Date.now() });

for (const [name, hung] of [
  ["config.json read", { envBin: () => undefined, readConfig: slow(1500, `{"rtk":{"path":"${BIN}"}}`) }],
  ["realpath", { realPath: slow(1500, BIN) }],
  ["CE_RTK_BIN lookup", { envBin: slow(1500, BIN) }],
] as const) {
  test(`a hung ${name} returns the original command within the budget, and its late answer changes no state`, async () => {
    const trust = createTrust();
    const cfg = gatewayConfig({ home: "/tmp/home", flag: undefined, host: "pi" });
    const started = Date.now();
    const r = await trustedRewrite({
      ports: realHost(), cfg, trust, realPath: async () => BIN, envBin: () => BIN, readConfig: async () => undefined, ...hung,
    }, "ls");
    expect(Date.now() - started).toBeLessThan(1400);
    expect(r).toMatchObject({ command: "ls", status: "error", reason: "rewrite_budget" });
    await new Promise(r => setTimeout(r, 600));
    expect(trust.byPath.size).toBe(0);
    expect(trust.reported.size).toBe(0);
  });
}
