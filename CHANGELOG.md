# context-economy

## 0.1.1

### Patch Changes

- e1597b0: Release tooling: promotion now sets the release bot's git identity before it runs, so each `promoted-v<version>` tag names the bot as its tagger. Without `RELEASE_BOT_EMAIL` the promotion stops before `release` moves.

## 0.1.0

### Minor Changes

- a7b622c: First preview release: tool-gateway for Claude Code and Pi.

### Patch Changes

- a7b622c: tool-gateway: commands that discard stderr with `2>/dev/null` are now rewritten through RTK instead of running unrewritten.
