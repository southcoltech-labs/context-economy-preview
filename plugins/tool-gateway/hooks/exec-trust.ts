// SPDX-License-Identifier: Apache-2.0

/**
 * Trusted executables (SPEC.md, "Trust check"). An executable is named by an absolute path from
 * configuration, never found on PATH. Its identity comes from the host's realpath and the system
 * `stat`, never from the executable being checked or an interpreter that could stand in for it.
 * The trust anchor is the root-owned system tools at fixed paths below.
 */
export type Run = (
  argv: readonly string[],
  init: { timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; isStdoutTruncated?: boolean }>;

export type ExecDeps = {
  run: Run;
  /** Where the path lands (host realpath); undefined when it leads nowhere. */
  realPath: (path: string) => Promise<string | undefined>;
  nowMs: () => number;
};

/** dev, ino and the times are opaque strings: compared, never computed (ino exceeds 2^53). */
export type Identity = {
  realPath: string;
  kind: "file" | "link" | "other";
  uid: number;
  mode: number;
  dev: string;
  ino: string;
  size: string;
  mtime: string;
  ctime: string;
};

export type Probe = { ok: true; identity: Identity; uid: number } | { ok: false; detail: string };

/** One deadline for a whole check: every subprocess gets only the time that is left. */
export type Deadline = { atMs: number };

/** The OS and the user's uid, read once per module life. */
export type HostCache = { host?: { os: string; uid: number } };

export const UNAME = "/usr/bin/uname";
export const ID = "/usr/bin/id";
export const STAT = "/usr/bin/stat";
/** The two supported platforms' `stat` dialects: `%p` octal (BSD), `%f` hex (GNU). */
const STAT_FORMATS: Record<string, { flag: string; format: string; modeRadix: number }> = {
  Darwin: { flag: "-f", format: "%p|%u|%d|%i|%z|%Fm|%Fc", modeRadix: 8 },
  Linux: { flag: "-c", format: "%f|%u|%d|%i|%s|%y|%z", modeRadix: 16 },
};
const STAT_FIELDS = 7;
const MAX_DETAIL = 200;
const TYPE_MASK = 0o170000;
const TYPE_FILE = 0o100000;
const TYPE_LINK = 0o120000;
const PERM_MASK = 0o7777;
const GROUP_OTHER_WRITE = 0o022;
const ROOT_UID = 0;

export const deadlineIn = (deps: Pick<ExecDeps, "nowMs">, budgetMs: number): Deadline =>
  ({ atMs: deps.nowMs() + budgetMs });

export const leftMs = (deps: Pick<ExecDeps, "nowMs">, d: Deadline): number => d.atMs - deps.nowMs();

export class BudgetExhausted extends Error {}

/**
 * Runs `argv` with the time left before `d`; throws when none is left, and when the result
 * arrives after `d` (a host whose timeout did not hold must not pass a late answer as in time).
 */
export async function runWithin(
  deps: Pick<ExecDeps, "run" | "nowMs">,
  argv: readonly string[],
  d: Deadline,
): Promise<Awaited<ReturnType<Run>>> {
  const timeoutMs = leftMs(deps, d);
  if (timeoutMs <= 0) throw new BudgetExhausted("time budget exhausted");
  const result = await deps.run(argv, { timeoutMs });
  if (leftMs(deps, d) < 0) throw new BudgetExhausted("answered after the time budget");
  return result;
}

const short = (text: string): string => text.slice(0, MAX_DETAIL);

async function hostOf(deps: ExecDeps, cache: HostCache, d: Deadline): Promise<{ os: string; uid: number }> {
  if (cache.host) return cache.host;
  const os = (await runWithin(deps, [UNAME, "-s"], d)).stdout.trim();
  const id = await runWithin(deps, [ID, "-u"], d);
  const uid = Number(id.stdout.trim());
  if (id.exitCode !== 0 || !Number.isInteger(uid)) throw new Error("id -u failed");
  cache.host = { os, uid };
  return cache.host;
}

/** Identity of the file `path` lands on, read by the system `stat` (lstat of the real path). */
export async function probeExecutable(
  deps: ExecDeps,
  cache: HostCache,
  path: string,
  d: Deadline,
): Promise<Probe> {
  if (!path.startsWith("/")) return { ok: false, detail: "not an absolute path" };
  try {
    const realPath = await deps.realPath(path);
    if (realPath === undefined || !realPath.startsWith("/")) return { ok: false, detail: "does not resolve" };
    const host = await hostOf(deps, cache, d);
    const dialect = STAT_FORMATS[host.os];
    if (!dialect) return { ok: false, detail: `unsupported platform ${short(host.os)}` };
    const r = await runWithin(deps, [STAT, dialect.flag, dialect.format, realPath], d);
    if (r.exitCode !== 0) return { ok: false, detail: `stat exited ${r.exitCode}` };
    const fields = r.stdout.trim().split("|");
    if (fields.length !== STAT_FIELDS) return { ok: false, detail: "stat: malformed output" };
    const [rawMode, rawUid, dev, ino, size, mtime, ctime] = fields as [string, string, string, string, string, string, string];
    const fullMode = parseInt(rawMode, dialect.modeRadix);
    const uid = Number(rawUid);
    if (!Number.isInteger(fullMode) || !Number.isInteger(uid)) return { ok: false, detail: "stat: malformed output" };
    const type = fullMode & TYPE_MASK;
    const kind = type === TYPE_FILE ? "file" : type === TYPE_LINK ? "link" : "other";
    return {
      ok: true,
      uid: host.uid,
      identity: { realPath, kind, uid, mode: fullMode & PERM_MASK, dev, ino, size, mtime, ctime },
    };
  } catch (error) {
    return { ok: false, detail: short(`check failed: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

/** A regular file owned by the user or root, not writable by group or others. */
export function untrusted(id: Identity, userUid: number): string | undefined {
  if (id.kind !== "file") return `not a regular file (${id.kind})`;
  if (id.uid !== userUid && id.uid !== ROOT_UID) return "owned by another user";
  if ((id.mode & GROUP_OTHER_WRITE) !== 0) return "writable by group or others";
  return undefined;
}

const IDENTITY_FIELDS = ["realPath", "dev", "ino", "size", "mtime", "ctime", "uid", "mode"] as const;

/** Any identity difference since the first check. */
export function changed(before: Identity, now: Identity): string | undefined {
  const field = IDENTITY_FIELDS.find(f => before[f] !== now[f]);
  return field ? `${field} changed since the session's first check` : undefined;
}
