// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "claude-code/testing";
import { bindRtk, shellQuote } from "./shell-grammar.ts";

const RTK = "/opt/rtk/bin/rtk";
const Q = shellQuote(RTK);

const accepted: [string, string][] = [
  ["rtk git status", `${Q} git status`],
  ["rtk git log && rtk ls -la", `${Q} git log && ${Q} ls -la`],
  ["cd foo && rtk cargo test", `cd foo && ${Q} cargo test`],
  ["rtk git status | head -5", `${Q} git status | head -5`],
  ["a || rtk b; rtk c", `a || ${Q} b; ${Q} c`],
  ["rtk grep 'a b' \"c d\" > out.txt 2>&1", `${Q} grep 'a b' "c d" > out.txt 2>&1`],
  ["rtk cat < in.txt >> log", `${Q} cat < in.txt >> log`],
  ["rtk read a.ts 2>/dev/null | head -60", `${Q} read a.ts 2>/dev/null | head -60`],
  ["rtk ls x 2> /dev/null; rtk ls y", `${Q} ls x 2> /dev/null; ${Q} ls y`],
  ["rtk ls x 2>'/dev/null'", `${Q} ls x 2>'/dev/null'`],
  // Quoted glob characters are literal: no expansion, so the command word is allowed.
  ["rtk ls && './r?k' x", `${Q} ls && './r?k' x`],
  ["rtk ls && \"/opt/a[1]/tool\" x", `${Q} ls && "/opt/a[1]/tool" x`],
];

for (const [output, expected] of accepted) {
  test(`accepts ${output}`, () => {
    expect(bindRtk(output, RTK)).toEqual({ ok: true, command: expected });
  });
}

const rejected = [
  "rtk x\nrm -rf /",
  "rtk x &",
  "$(rtk x)",
  "`rtk x`",
  "rtk \"$HOME\"",
  "( rtk x )",
  "{ rtk x; }",
  "rtk cat <<EOF",
  "xargs rtk",
  "find . -exec rtk ls ;",
  "sh -c 'rtk x'",
  "eval rtk x",
  "env rtk x",
  "echo 'rtk'",
  "'rtk' x",
  "PATH=/tmp rtk x",
  "rtk x |& tee",
  // Implementation review finding 4: path-qualified wrappers and expansion in a command word.
  "rtk git status && /bin/sh -c echo",
  "rtk git status && /usr/bin/env git status",
  "rtk git status && '/bin/bash' -c x",
  "rtk git status && ./r?k git status",
  "rtk git status && ./rt* git status",
  "rtk git status && [r]tk git status",
  "rtk git status && ~/bin/tool x",
  "rtk ls; /usr/bin/xargs echo",
  // Re-review finding 2: an unquoted glob beside a quoted fragment still expands.
  'rtk git status && ./r""?k git status',
  'rtk git status && "./r"?k git status',
  'rtk git status && ./r?"k" git status',
  "rtk git status && ~'/bin/tool' x",
  "rtk x 2> err",
  "rtk x 2>/dev/nullx",
  "rtk x 2>>/dev/null",
  "rtk x 2>&2",
  "rtk x 2>|/dev/null",
  "rtk x 2>",
  "rtk x 2>/dev/null rtk",
  "rtk x 1>/dev/null",
  "rtk x >| f",
  "rtk x &> f",
  "rtk x # hidden",
  "rtk x &&",
  "| rtk x",
  "rtk 'unterminated",
  "git status",
  "",
];

for (const output of rejected) {
  test(`rejects ${JSON.stringify(output)}`, () => {
    expect(bindRtk(output, RTK).ok).toBe(false);
  });
}

test("quotes a verified path with spaces and quotes", () => {
  const odd = "/Users/a b/it's/rtk";
  const r = bindRtk("rtk ls", odd);
  expect(r).toEqual({ ok: true, command: `'/Users/a b/it'\\''s/rtk' ls` });
});
