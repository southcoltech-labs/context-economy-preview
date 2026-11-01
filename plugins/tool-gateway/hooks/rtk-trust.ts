// SPDX-License-Identifier: Apache-2.0

import { BudgetExhausted, changed, probeExecutable, runWithin, untrusted } from "./exec-trust.ts";
import type { Deadline, ExecDeps, HostCache, Identity } from "./exec-trust.ts";

/**
 * RTK trust (SPEC.md, "Trust check"). The executable comes only from `CE_RTK_BIN` or
 * config `rtk.path`, never PATH. The first check of a path verifies it and records its
 * identity; every later check revalidates. Identity comes from the system `stat` (see
 * exec-trust.ts): no interpreter is involved. The whole check runs inside the caller's deadline.
 * A failure turns rewrite off for that path for this module's life.
 */
export const RTK_BIN_ENV = "CE_RTK_BIN";
export const VERSION_MAX_BYTES = 4096;
/** Supported RTK versions: [min, maxExclusive). The minimum is the version E1a runs with. */
export const RTK_MIN_VERSION: Version = [0, 47, 0];
export const RTK_MAX_VERSION_EXCLUSIVE: Version = [1, 0, 0];
const VERSION_PATTERN = /^rtk (\d+)\.(\d+)\.(\d+)/;

type Version = readonly [number, number, number];

export type TrustOff =
  | "rtk_unconfigured"
  | "rtk_config_invalid"
  | "rtk_untrusted"
  | "rtk_version"
  | "rtk_changed"
  | "rtk_check_failed";

export type TrustDeps = {
  exec: ExecDeps;
  /** `CE_RTK_BIN`, else the text of `~/.claude/context-economy/config.json` (undefined: absent). */
  envBin: () => Promise<string | undefined> | string | undefined;
  readConfig: () => Promise<string | undefined>;
  /** False once the caller has given up on this check: it must then change no state. */
  isCurrent?: () => boolean;
};

export type TrustState =
  | { status: "trusted"; identity: Identity }
  | { status: "off"; reason: TrustOff; detail: string };

export type TrustVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: TrustOff; detail: string; isNew: boolean };

/**
 * One module's trust: a state per configured path (a different path is verified afresh), the
 * off reasons already reported (one status line each), and the host facts. A reload starts over.
 */
export type Trust = { byPath: Map<string, TrustState>; reported: Set<string>; host: HostCache };

export function createTrust(): Trust {
  return { byPath: new Map(), reported: new Set(), host: {} };
}

export async function checkRtk(trust: Trust, deps: TrustDeps, deadline: Deadline): Promise<TrustVerdict> {
  const current = (): void => {
    if (deps.isCurrent && !deps.isCurrent()) throw new BudgetExhausted("check outlived its caller");
  };
  const report = (reason: TrustOff, detail: string, key: string): TrustVerdict => {
    current();
    const isNew = !trust.reported.has(key);
    trust.reported.add(key);
    return { ok: false, reason, detail, isNew };
  };
  const configured = await configuredPath(deps);
  if (!configured.ok) return report(configured.reason, configured.detail, configured.reason);
  const key = configured.path;
  const off = (reason: TrustOff, detail: string): TrustVerdict => {
    current();
    trust.byPath.set(key, { status: "off", reason, detail });
    return report(reason, detail, `${reason}:${key}`);
  };
  const prior = trust.byPath.get(key);
  if (prior?.status === "off") return report(prior.reason, prior.detail, `${prior.reason}:${key}`);
  if (prior?.status === "trusted") {
    const now = await probeExecutable(deps.exec, trust.host, configured.path, deadline);
    if (!now.ok) return off("rtk_check_failed", now.detail);
    const problem = untrusted(now.identity, now.uid) ?? changed(prior.identity, now.identity);
    if (problem) return off("rtk_changed", problem);
    return { ok: true, path: prior.identity.realPath };
  }
  const first = await probeExecutable(deps.exec, trust.host, configured.path, deadline);
  if (!first.ok) return off("rtk_untrusted", first.detail);
  const problem = untrusted(first.identity, first.uid);
  if (problem) return off("rtk_untrusted", problem);
  const version = await checkVersion(deps.exec, first.identity.realPath, deadline);
  if (version) return off("rtk_version", version);
  current();
  trust.byPath.set(key, { status: "trusted", identity: first.identity });
  return { ok: true, path: first.identity.realPath };
}

type Configured = { ok: true; path: string } | { ok: false; reason: TrustOff; detail: string };

async function configuredPath(deps: TrustDeps): Promise<Configured> {
  const fromEnv = (await deps.envBin())?.trim();
  let path = fromEnv || undefined;
  if (path === undefined) {
    let text: string | undefined;
    try {
      text = await deps.readConfig();
    } catch (error) {
      return { ok: false, reason: "rtk_config_invalid", detail: `config unreadable: ${String(error)}` };
    }
    if (text === undefined) return { ok: false, reason: "rtk_unconfigured", detail: `set ${RTK_BIN_ENV}` };
    try {
      const parsed = JSON.parse(text) as { rtk?: { path?: unknown } };
      const p = parsed?.rtk?.path;
      if (p === undefined) return { ok: false, reason: "rtk_unconfigured", detail: "config has no rtk.path" };
      if (typeof p !== "string") return { ok: false, reason: "rtk_config_invalid", detail: "rtk.path is not a string" };
      path = p.trim();
    } catch {
      return { ok: false, reason: "rtk_config_invalid", detail: "config is not JSON" };
    }
  }
  if (!path.startsWith("/")) return { ok: false, reason: "rtk_config_invalid", detail: "rtk path is not absolute" };
  return { ok: true, path };
}

async function checkVersion(exec: ExecDeps, realPath: string, deadline: Deadline): Promise<string | undefined> {
  let stdout: string;
  try {
    const r = await runWithin(exec, [realPath, "--version"], deadline);
    if (r.exitCode !== 0) return `--version exited ${r.exitCode}`;
    if (r.isStdoutTruncated || r.stdout.length > VERSION_MAX_BYTES) return "--version output too large";
    stdout = r.stdout;
  } catch (error) {
    return `--version failed: ${String(error)}`.slice(0, 200);
  }
  const m = VERSION_PATTERN.exec(stdout);
  if (!m) return "--version is not RTK's";
  const v: Version = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (compare(v, RTK_MIN_VERSION) < 0 || compare(v, RTK_MAX_VERSION_EXCLUSIVE) >= 0) {
    return `rtk ${v.join(".")} outside supported ${RTK_MIN_VERSION.join(".")}..<${RTK_MAX_VERSION_EXCLUSIVE.join(".")}`;
  }
  return undefined;
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
