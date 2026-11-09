---
"context-economy": patch
---

Release tooling: promotion now sets the release bot's git identity before it runs, so each `promoted-v<version>` tag names the bot as its tagger. Without `RELEASE_BOT_EMAIL` the promotion stops before `release` moves.
