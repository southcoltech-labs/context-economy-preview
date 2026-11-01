// SPDX-License-Identifier: Apache-2.0

// The README's RTK install block must fail closed: an unsupported platform, a failed
// download, a missing checksum entry or a checksum mismatch stops it before anything is unpacked
// or run. The block is read from README.md and run verbatim under each available shell, with
// stand-ins for curl and uname that serve local, synthetic files. No network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const MAC = "rtk-aarch64-apple-darwin.tar.gz";
const LINUX = "rtk-x86_64-unknown-linux-musl.tar.gz";

/** The first ```bash block after the "**RTK 0.47.0.**" paragraph. */
function rtkBlock() {
  const text = readFileSync(README, "utf8");
  const from = text.indexOf("**RTK 0.47.0.**");
  const start = text.indexOf("```bash\n", from) + "```bash\n".length;
  return text.slice(start, text.indexOf("\n```", start));
}

const which = (cmd) => spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim() || undefined;
const SHELLS = ["bash", "zsh"].map((s) => [s, which(s)]).filter(([, p]) => p);
const TOOLS = { shasum: which("shasum"), sha256sum: which("sha256sum") };

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A tar.gz holding an `rtk` script that leaves `marker` when run and prints the version. */
function archive(dir, name, marker) {
  const src = mkdtempSync(join(tmpdir(), "rtk-src-"));
  writeFileSync(join(src, "rtk"), `#!/bin/sh\ntouch '${marker}'\necho "rtk 0.47.0"\n`);
  chmodSync(join(src, "rtk"), 0o755);
  execFileSync("tar", ["-czf", join(dir, name), "-C", src, "rtk"]);
}

/** Runs the block in a fresh HOME; `files` is what the fake curl can serve. */
function runBlock(shell, { os = "Darwin", arch = "arm64", files }) {
  const w = mkdtempSync(join(tmpdir(), "readme-rtk-"));
  const bin = join(w, "bin");
  const served = join(w, "served");
  mkdirSync(bin);
  mkdirSync(served);
  for (const [name, write] of Object.entries(files)) write(join(served, name));
  const calls = join(w, "calls");
  const stub = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub("curl", `echo "curl $*" >> '${calls}'\nfor a; do url=$a; done\nf=$(basename "$url")\n[ -f '${served}'/"$f" ] || { echo "curl: (22) 404 $f" >&2; exit 22; }\ncp '${served}'/"$f" .`);
  stub("uname", `case "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac`);
  for (const [tool, path] of Object.entries(TOOLS)) if (path) stub(tool, `echo "${tool}" >> '${calls}'\nexec '${path}' "$@"`);
  const r = spawnSync(shell, ["-c", rtkBlock()], {
    cwd: w, encoding: "utf8", env: { HOME: join(w, "home"), PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    extracted: existsSync(join(w, "home/.local/opt/rtk-0.47.0/rtk")),
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
  };
}

/**
 * One case. The archive's `rtk` leaves a marker when run; checksums.txt holds its real hash.
 * `tamper` alters the served archive after hashing, `dropEntry` removes its checksum line,
 * `dropAsset` makes its download fail.
 */
function scenario(shell, { asset = MAC, tamper = false, dropEntry = false, dropAsset = false } = {}, platform = {}) {
  const marker = join(mkdtempSync(join(tmpdir(), "readme-rtk-case-")), "RAN");
  const real = mkdtempSync(join(tmpdir(), "rtk-real-"));
  archive(real, asset, marker);
  const files = {
    "checksums.txt": (to) => writeFileSync(to, [
      `${"0".repeat(64)}  rtk-x86_64-pc-windows-msvc.zip`,
      ...(dropEntry ? [] : [`${sha256(join(real, asset))}  ${asset}`]),
      "",
    ].join("\n")),
  };
  if (!dropAsset) {
    files[asset] = (to) => {
      writeFileSync(to, readFileSync(join(real, asset)));
      if (tamper) appendFileSync(to, "x");
    };
  }
  return { ...runBlock(shell, { ...platform, files }), ran: existsSync(marker) };
}

for (const [shell, path] of SHELLS) {
  test(`${shell}: a verified archive is unpacked and reports its version`, { skip: !TOOLS.shasum && "no shasum" }, () => {
    const r = scenario(path);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.extracted);
    assert.match(r.out, /rtk 0\.47\.0/);
    assert.match(r.out, /rtk\.path: .*\/\.local\/opt\/rtk-0\.47\.0\/rtk/);
    assert.match(r.calls, /^shasum$/m);
  });

  const refusals = [
    ["a checksum mismatch", { tamper: true }, {}, /FAILED|did NOT match/],
    ["a missing checksum entry", { dropEntry: true }, {}, /no checksum for/],
    ["a failed download", { dropAsset: true }, {}, /curl: \(22\)/],
    ["an unsupported platform", {}, { arch: "x86_64" }, /unsupported platform: Darwin-x86_64/],
  ];
  for (const [label, opts, platform, message] of refusals) {
    test(`${shell}: ${label} stops before anything is unpacked or run`, { skip: !TOOLS.shasum && "no shasum" }, () => {
      const r = scenario(path, opts, platform);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, message);
      assert.equal(r.extracted, false, r.out);
      assert.equal(r.ran, false, r.out);
    });
  }

  test(`${shell}: an unsupported platform downloads nothing`, () => {
    const r = scenario(path, {}, { arch: "x86_64" });
    assert.equal(r.calls.includes("curl"), false);
  });

  test(`${shell}: Linux x86_64 takes the musl archive and verifies it with sha256sum`, { skip: !TOOLS.sha256sum && "no sha256sum" }, () => {
    const r = scenario(path, { asset: LINUX }, { os: "Linux", arch: "x86_64" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.calls, /^sha256sum$/m);
    assert.doesNotMatch(r.calls, /^shasum$/m);
    assert.match(r.calls, new RegExp(`curl .*${LINUX.replaceAll(".", "\\.")}`));
  });
}
