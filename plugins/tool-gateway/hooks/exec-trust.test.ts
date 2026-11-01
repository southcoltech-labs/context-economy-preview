// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "claude-code/testing";
import { BudgetExhausted, deadlineIn, probeExecutable, runWithin } from "./exec-trust.ts";
import type { ExecDeps } from "./exec-trust.ts";

function deps(os: string, statOut: string, argvs: (readonly string[])[] = []): ExecDeps {
  return {
    nowMs: () => Date.now(),
    realPath: async () => "/usr/local/bin/tool",
    run: async argv => {
      argvs.push(argv);
      if (argv[0] === "/usr/bin/uname") return { exitCode: 0, stdout: `${os}\n` };
      if (argv[0] === "/usr/bin/id") return { exitCode: 0, stdout: "1000\n" };
      return { exitCode: 0, stdout: statOut };
    },
  };
}

test("Linux: reads GNU stat -c output (hex mode, readable times)", async () => {
  const argvs: (readonly string[])[] = [];
  const d = deps("Linux", "81ed|0|2049|1234567|4096|2026-10-24 12:00:00.123456789 +0000|2026-10-24 12:00:01.000000000 +0000\n", argvs);
  const r = await probeExecutable(d, {}, "/usr/local/bin/tool", deadlineIn(d, 1000));

  expect(r).toEqual({
    ok: true,
    uid: 1000,
    identity: {
      realPath: "/usr/local/bin/tool", kind: "file", uid: 0, mode: 0o755, dev: "2049", ino: "1234567",
      size: "4096", mtime: "2026-10-24 12:00:00.123456789 +0000", ctime: "2026-10-24 12:00:01.000000000 +0000",
    },
  });
  expect(argvs.find(a => a[0] === "/usr/bin/stat")?.slice(1, 2)).toEqual(["-c"]);
});

test("macOS: reads BSD stat -f output (octal mode); a large inode keeps its digits", async () => {
  const d = deps("Darwin", "100755|501|16777233|1152921500312607511|200560|1788431650.000000000|1788431650.000000000\n");
  const r = await probeExecutable(d, {}, "/usr/local/bin/tool", deadlineIn(d, 1000));

  expect(r.ok && r.identity.ino).toBe("1152921500312607511");
  expect(r.ok && r.identity.mode).toBe(0o755);
});

test("an unsupported platform, a relative path or an exhausted budget is not trusted", async () => {
  const d = deps("SunOS", "");
  expect((await probeExecutable(d, {}, "/x", deadlineIn(d, 1000))).ok).toBe(false);
  expect((await probeExecutable(d, {}, "python3", deadlineIn(d, 1000))).ok).toBe(false);
  const linux = deps("Linux", "81ed|0|1|2|3|4|5");
  expect((await probeExecutable(linux, {}, "/x", deadlineIn(linux, 0))).ok).toBe(false);
});

test("an answer that arrives after the deadline is refused, whatever the host's timeout did", async () => {
  let now = 1000;
  const d = { nowMs: () => now, run: async () => { now += 1500; return { exitCode: 0, stdout: "rtk 0.47.0\n" }; } };
  await expect(runWithin(d, ["/x", "--version"], deadlineIn(d, 1000))).rejects.toBeInstanceOf(BudgetExhausted);
  now = 1000;
  const inTime = { nowMs: () => now, run: async () => { now += 999; return { exitCode: 0, stdout: "ok" }; } };
  expect((await runWithin(inTime, ["/x"], deadlineIn(inTime, 1000))).stdout).toBe("ok");
});
