// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "claude-code/testing";
import type { GatewayConfig, Ports } from "./types.ts";
import { rewriteWith } from "./rewrite.ts";

const cfg: GatewayConfig = {
  enabled: true,
  schema: "ce.claude-gateway.v1",
  ledgerPath: "/tmp/gateway-ledger.jsonl",
  rewriteTimeoutMs: 1000,
};

test("RTK rewrite applies a returned command", async () => {
  const ports = fakePorts({ exitCode: 0, stdout: "rtk git status\n" });
  const result = await rewriteWith(ports, cfg, "rtk", "git status");
  expect(result.command).toBe("rtk git status");
  expect(result.status).toBe("applied");
});

test("RTK exit 3 applies a changed command", async () => {
  const ports = fakePorts({ exitCode: 3, stdout: "rtk git status\n" });
  const result = await rewriteWith(ports, cfg, "rtk", "git status");
  expect(result.command).toBe("rtk git status");
  expect(result.status).toBe("applied");
});

test("RTK no-equivalent result preserves the command", async () => {
  const ports = fakePorts({ exitCode: 1, stdout: "" });
  const result = await rewriteWith(ports, cfg, "rtk", "python3 script.py");
  expect(result.command).toBe("python3 script.py");
  expect(result.status).toBe("none");
});

test("RTK failures preserve the command", async () => {
  const ports = fakePorts({ exitCode: 2, stdout: "partial" });
  const result = await rewriteWith(ports, cfg, "rtk", "git status");
  expect(result.command).toBe("git status");
  expect(result.status).toBe("error");
});

test("RTK exit 3 with unchanged command is not applied", async () => {
  const ports = fakePorts({ exitCode: 3, stdout: "git status\n" });
  const result = await rewriteWith(ports, cfg, "rtk", "git status");
  expect(result.command).toBe("git status");
  expect(result.status).toBe("none");
});

test("truncated RTK output is never applied, even a valid-looking prefix", async () => {
  const ports = fakePorts({ exitCode: 0, stdout: "rtk git status", isStdoutTruncated: true });
  const result = await rewriteWith(ports, cfg, "rtk", "git status && run-required-check");
  expect(result.command).toBe("git status && run-required-check");
  expect(result.status).toBe("error");
  expect(result.reason).toBe("rewrite_truncated");
});

test("disabled gateway does not invoke RTK", async () => {
  const ports = fakePorts({ exitCode: 0, stdout: "unexpected" });
  const result = await rewriteWith(ports, { ...cfg, enabled: false }, "rtk", "git status");
  expect(result.command).toBe("git status");
  expect(result.status).toBe("off");
});

function fakePorts(
  response: { exitCode: number; stdout: string; isStdoutTruncated?: boolean },
): Ports {
  return {
    run: async () => ({ ...response, stderr: "" }),
    writeFile: async () => undefined,
    status: () => undefined,
    nowMs: () => 100,
    sleep: async () => undefined,
  };
}
