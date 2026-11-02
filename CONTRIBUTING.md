# Contributing

Thank you for helping. This file covers the toolchain, the tests, and how a change reaches a
release. Report security issues privately, as [SECURITY.md](SECURITY.md) describes, not in an
issue.

## Toolchain

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 24 or later | Release tooling and its tests |
| Claude Code | 2.1.310, the version CI pins | `claude plugin validate`, `claude plugin test` |
| Bun | 1.4.4 | The Pi extension's tests |
| RTK | 0.47.0 | Trying the gateway by hand ([README](README.md#1-configure-rtk)) |

## Tests

```bash
npm ci
npm run -s test:tooling                 # release tooling (node --test)
npm run -s version:check                # manifests share one version
claude plugin validate . --strict
claude plugin test plugins/tool-gateway # Claude Code plugin and the shared core
bun test extensions                     # Pi extension
```

CI runs the same on macOS arm64 and Linux x86_64, and its 5 checks must pass before a pull request
merges.

The Claude Code tests run only through `claude plugin test`: `claude-code/testing` is provided by
that runner, so `bun test` cannot load them. The Pi tests stub the Pi host. The Pi package is an
optional peer dependency and is not installed for them.

## Types

The plugin's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes,
with the host's type declarations, when a session loads the plugin:

```bash
claude --plugin-dir "$PWD/plugins/tool-gateway"   # start it once, then quit
npx -p typescript tsc -p plugins/tool-gateway --noEmit
```

The generated folder is ignored by git. The Pi extension declares the small part of Pi's API it
uses as local structural types.

## Making a change

- Keep to the behaviour in [plugins/tool-gateway/SPEC.md](plugins/tool-gateway/SPEC.md). A change
  of behaviour changes the spec in the same pull request.
- Add a test that fails without the change.
- Match the surrounding code: names, comment density and idiom.
- Start each new source file with `// SPDX-License-Identifier: Apache-2.0` (`#` in shell and
  YAML), after the shebang if there is one. The tooling tests check it.
- Add a changeset for anything users would notice: `npm run changeset`. See
  [.changeset/README.md](.changeset/README.md). A documentation-only pull request is labeled
  `no-release` instead.

## Supported environments

macOS on Apple silicon and Linux x86_64, with the host and RTK versions in the
[README](README.md#supported-environment). Windows is not supported. A change to a supported
version goes through the release checks again.

## License

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE), as the rest of the project is.

## Sign-off

Every commit in a pull request is signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). The sign-off certifies
that you wrote the change, or otherwise have the right to submit it under the project's license,
and that a record of it, including your name and e-mail, is kept publicly in the history.

Sign off with `-s`, which adds a line made from your git `user.name` and `user.email`:

```bash
git commit -s -m "Explain the change"
# Signed-off-by: Your Name <you@example.com>
```

The sign-off must match the commit's author. Use a name and e-mail you are known by; anonymous
sign-offs are not accepted. A sign-off does not transfer your copyright.

Pull requests contain no merge commits: to bring in changes from `main`, rebase your branch onto
it instead of merging it in. The only commit accepted without a sign-off is the release
automation's own version commit.

The `repo checks` job fails a pull request with any commit that breaks these rules, and names
each one. To fix it, sign off the commits, rebase away any merge, and force-push the branch:

```bash
git commit --amend -s --no-edit   # the last commit only
git rebase --signoff main         # every commit since main; also replays away merge commits
git push --force-with-lease
```

Licensing questions: license@southcoltech.com.
