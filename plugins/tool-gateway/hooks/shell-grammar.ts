// SPDX-License-Identifier: Apache-2.0

/**
 * The only shell grammar accepted from `rtk rewrite` output. Simple commands of words (bare,
 * single-quoted, or double-quoted with no `$`, backtick or backslash) joined by `|`, `&&`, `||`
 * or `;`, with `<`, `>`, `>>` to a plain word, `2>&1`, and `2>` to `/dev/null` only. Everything
 * else is rejected, so the original command runs. Each `rtk` in command position becomes the quoted verified path. A command
 * word may not be a wrapper (by name or path, e.g. `/bin/sh`, `/usr/bin/env`) or carry pathname or
 * tilde expansion (`./r?k`), since either could run something other than what was checked.
 */
export type BindResult = { ok: true; command: string } | { ok: false; reason: string };

const OPERATORS = ["&&", "||", "|", ";"] as const;
const REDIRECTS = [">>", ">", "<"] as const;
const FD_DUP = "2>&1";
/** Discarding stderr is the only fd-numbered redirect allowed, and only to this target. */
const STDERR = "2>";
const STDERR_TARGET = "/dev/null";
const RTK = "rtk";
/** Command words that run their arguments as another command; matched on the basename too. */
const WRAPPERS = new Set([
  "eval", "exec", "env", "command", "builtin", "xargs", "sudo", "doas", "su", "nohup", "time",
  "nice", "ionice", "timeout", "watch", "stdbuf", "setsid", "flock", "chroot", "caffeinate", "arch",
  "source", ".", "sh", "bash", "zsh", "dash", "ksh", "mksh", "tcsh", "csh", "fish", "busybox",
]);
/** Shell expansion in a bare command word (pathname, tilde) could pick an unverified executable. */
const COMMAND_EXPANSION = /[*?[\]~]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RTK_WORD = /(^|[^A-Za-z0-9_-])rtk([^A-Za-z0-9_-]|$)/;
const BARE_FORBIDDEN = new Set(["$", "`", "\\", "(", ")", "{", "}", "&", "!", "#", "\n", "\r"]);
const DOUBLE_FORBIDDEN = new Set(["$", "`", "\\", "\n", "\r"]);
const SPACE = new Set([" ", "\t"]);

/** `isBare`: no quoted fragment. `expands`: some unquoted character is a glob or tilde. */
type Word = { kind: "word"; value: string; start: number; end: number; isBare: boolean; expands: boolean };
type Op = { kind: "op"; text: string };
type Redirect = { kind: "redirect"; text: string };
type Token = Word | Op | Redirect;

type Lexed = { ok: true; tokens: Token[] } | { ok: false; reason: string };

function lex(text: string): Lexed {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (SPACE.has(c)) { i += 1; continue; }
    const op = OPERATORS.find(o => text.startsWith(o, i));
    if (op) {
      if (text.startsWith("|&", i) || text.startsWith(";;", i)) return { ok: false, reason: "operator" };
      tokens.push({ kind: "op", text: op });
      i += op.length;
      continue;
    }
    if (text.startsWith(FD_DUP, i) && isBoundary(text, i - 1) && isBoundary(text, i + FD_DUP.length)) {
      tokens.push({ kind: "redirect", text: FD_DUP });
      i += FD_DUP.length;
      continue;
    }
    if (text.startsWith(STDERR, i) && isBoundary(text, i - 1) && !/^2>[>&|]/.test(text.slice(i, i + 3))) {
      tokens.push({ kind: "redirect", text: STDERR });
      i += STDERR.length;
      continue;
    }
    if (c === "<" || c === ">") {
      if (/^(<<|<>|<&|>&|>\||&>)/.test(text.slice(i, i + 2))) return { ok: false, reason: "redirect" };
      const r = REDIRECTS.find(x => text.startsWith(x, i)) as string;
      tokens.push({ kind: "redirect", text: r });
      i += r.length;
      continue;
    }
    const word = lexWord(text, i);
    if (!word.ok) return word;
    tokens.push(word.word);
    i = word.word.end;
  }
  return { ok: true, tokens };
}

const isBoundary = (text: string, at: number): boolean =>
  at < 0 || at >= text.length || SPACE.has(text[at] as string) || ";|&".includes(text[at] as string);

function lexWord(
  text: string,
  start: number,
): { ok: true; word: Word } | { ok: false; reason: string } {
  let i = start;
  let value = "";
  let isBare = true;
  let expands = false;
  while (i < text.length) {
    const c = text[i] as string;
    if (SPACE.has(c) || c === ";" || c === "|" || c === "<" || c === ">") break;
    if (c === "&") {
      if (text.startsWith("&&", i)) break;
      return { ok: false, reason: "background" };
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return { ok: false, reason: "unterminated quote" };
      const inner = text.slice(i + 1, close);
      if (/[\n\r]/.test(inner)) return { ok: false, reason: "newline" };
      value += inner;
      isBare = false;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) return { ok: false, reason: "unterminated quote" };
      const inner = text.slice(i + 1, close);
      if ([...inner].some(ch => DOUBLE_FORBIDDEN.has(ch))) return { ok: false, reason: "expansion" };
      value += inner;
      isBare = false;
      i = close + 1;
      continue;
    }
    if (BARE_FORBIDDEN.has(c)) return { ok: false, reason: `unsupported ${JSON.stringify(c)}` };
    if (COMMAND_EXPANSION.test(c)) expands = true;
    value += c;
    i += 1;
  }
  if (value === "" && isBare) return { ok: false, reason: "empty word" };
  if (/^\d+$/.test(value) && isBare && (text[i] === ">" || text[i] === "<")) {
    return { ok: false, reason: "fd redirect" };
  }
  return { ok: true, word: { kind: "word", value, start, end: i, isBare, expands } };
}

/** Shell single-quoting: safe for any path. */
export const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** Checks `output` against the grammar and binds each command-position `rtk` to `rtkPath`. */
export function bindRtk(output: string, rtkPath: string): BindResult {
  const text = output.trim();
  if (text === "") return { ok: false, reason: "empty" };
  const lexed = lex(text);
  if (!lexed.ok) return lexed;
  const spans: { start: number; end: number }[] = [];
  let atCommand = true;
  let afterRedirect = false;
  let redirect = "";
  for (const t of lexed.tokens) {
    if (t.kind === "op") {
      if (atCommand || afterRedirect) return { ok: false, reason: "empty command" };
      atCommand = true;
      continue;
    }
    if (t.kind === "redirect") {
      if (atCommand || afterRedirect) return { ok: false, reason: "redirect position" };
      afterRedirect = t.text !== FD_DUP;
      redirect = t.text;
      continue;
    }
    if (afterRedirect) {
      if (RTK_WORD.test(t.value)) return { ok: false, reason: "rtk outside command position" };
      if (redirect === STDERR && t.value !== STDERR_TARGET) return { ok: false, reason: "fd redirect" };
      afterRedirect = false;
      continue;
    }
    if (atCommand) {
      atCommand = false;
      if (ASSIGNMENT.test(t.value)) return { ok: false, reason: "assignment" };
      const base = t.value.slice(t.value.lastIndexOf("/") + 1);
      if (WRAPPERS.has(t.value) || WRAPPERS.has(base)) return { ok: false, reason: `wrapper ${base}` };
      if (t.expands) return { ok: false, reason: "expansion in command word" };
      if (t.value === RTK && t.isBare) { spans.push(t); continue; }
    }
    if (RTK_WORD.test(t.value)) return { ok: false, reason: "rtk outside command position" };
  }
  if (atCommand || afterRedirect) return { ok: false, reason: "trailing operator" };
  if (spans.length === 0) return { ok: false, reason: "no rtk command" };
  let command = "";
  let from = 0;
  for (const s of spans) {
    command += text.slice(from, s.start) + shellQuote(rtkPath);
    from = s.end;
  }
  return { ok: true, command: command + text.slice(from) };
}
