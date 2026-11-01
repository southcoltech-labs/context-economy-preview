// SPDX-License-Identifier: Apache-2.0

import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { gatewayConfig } from "./config.ts";

test("missing HOME disables the gateway with a reason", () => {
  const cfg = gatewayConfig({ home: undefined, flag: undefined, host: "claude" });
  expect(cfg.enabled).toBe(false);
  expect(cfg.disabledReason).toBe("home_missing");
});

test("empty HOME disables the gateway with a reason", () => {
  const cfg = gatewayConfig({ home: "", flag: undefined, host: "claude" });
  expect(cfg.enabled).toBe(false);
  expect(cfg.disabledReason).toBe("home_missing");
});

test("the kill switch disables the gateway", () => {
  const cfg = gatewayConfig({ home: "/tmp/home", flag: "off", host: "claude" });
  expect(cfg.enabled).toBe(false);
  expect(cfg.disabledReason).toBeUndefined();
});

test("normal configuration enables the gateway", () => {
  const cfg = gatewayConfig({ home: "/tmp/home", flag: undefined, host: "claude" });
  expect(cfg.enabled).toBe(true);
  expect(cfg.ledgerPath).toBe("/tmp/home/.claude/context-economy/gateway-ledger");
});

test("a thrown tool call is ledgered and rethrown", async ($, on) => {
  const writes: string[] = [];
  installThrowingTool(on, writes);
  let didThrow = false;
  try {
    await $.tool.call({ tool: "Bash", command: "explode" });
  } catch {
    didThrow = true;
  }

  expect(didThrow).toBe(true);
  expect(writes).toHaveLength(1);
  const row = JSON.parse(writes[0]) as Record<string, unknown>;
  expect(row.is_error).toBe(true);
  expect(row.admit).toBe("skipped");
  expect(row.admit_reason).toBe("tool_threw");
});

function installThrowingTool(on: On, writes: string[]): void {
  mock.env(on, { HOME: "/tmp/gateway-throw-test" });
  on("fs.write", (_, event) => {
    const rows = event.text.trim().split("\n");
    writes.push(rows[rows.length - 1] ?? "{}");
    return { value: undefined };
  });
  on("process.run", (_, event) => {
    if (event.argv[0] === "rtk") {
      return { value: { exitCode: 1, stdout: "", stderr: "" } };
    }
    return { deny: "unexpected process" };
  });
  on("tool.call", { tool: "Bash" }, () => {
    throw new Error("tool threw as requested");
  });
}

test("the pi host gets its own schema and ledger directory", () => {
  const cfg = gatewayConfig({ home: "/tmp/home", flag: undefined, host: "pi" });
  expect(cfg.schema).toBe("ce.pi-gateway.v1");
  expect(cfg.ledgerPath).toBe("/tmp/home/.claude/context-economy/gateway-ledger-pi");
});

test("an unknown host fails fast", () => {
  expect(() => gatewayConfig({ home: "/tmp/home", flag: undefined, host: "x" as never })).toThrow("unknown gateway host");
});
