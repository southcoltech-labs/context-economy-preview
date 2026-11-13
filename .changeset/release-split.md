---
"context-economy": patch
---

Release tooling: candidates and promotion now use separate GitHub Apps and environments. `release.yml` first reads the release state in a job with no environment and no secrets, and starts the candidate job only when there is a version PR to open or update, a candidate to tag, or a missing GitHub release to repair. Merges with nothing to release no longer wait for an approval. Promotion still needs a second maintainer.
