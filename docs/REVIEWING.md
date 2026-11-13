# Reviewing a pull request

Every pull request needs an approving review before it merges. The reviewer goes through
[All pull requests](#all-pull-requests), then each section for the paths it changes. CI's
`repo checks` job writes the list of sections that apply into the run's summary ("Review scope"),
with any test files the pull request deletes.

CI checks the mechanical rules: sign-off and no merge commits (`scripts/signoff-gate.mjs`), the
changeset (`scripts/changeset-gate.mjs`), and the workflow rules below
(`scripts/workflow-policy.mjs`). Those checks run from the pull request's own checkout, so a
pull request can change them. A green run is not enough on its own: the review is what holds a
change to a check, a workflow or this file.

## All pull requests

- [ ] Every commit is signed off by its author, and there are no merge commits (CI). The author is
      someone the project can identify.
- [ ] The change does what the description says, and nothing else is mixed in.
- [ ] A change of behaviour changes `plugins/tool-gateway/SPEC.md` in the same pull request.
- [ ] A new test fails without the change. No test is deleted, skipped or weakened to make the
      change pass.
- [ ] A changeset is present, or the pull request is documentation only and labeled `no-release`.
- [ ] No secret, token, private key, personal data or internal host name, in code, tests, fixtures
      or commit messages. Synthetic secrets in tests are clearly fake.
- [ ] New source files start with the SPDX tag. Code copied from elsewhere has a license
      compatible with Apache-2.0, and its notice is kept.
- [ ] README, SECURITY.md or CONTRIBUTING.md change with anything users or contributors would
      notice.

## Workflows

`.github/workflows/`

- [ ] No `pull_request_target` or `workflow_run` trigger. Contributor code never runs with secrets
      or a write token (CI).
- [ ] Each workflow sets top-level `permissions`; `ci.yml`, `release.yml` and `promote.yml` keep
      `contents: read` only, with no job widening it (CI). Writes use an App token, minted only
      inside an environment.
- [ ] Every action is pinned to a full commit SHA, with its version in a comment (CI). A new
      action, or a new SHA, comes from the action's own repository, and its release was read.
- [ ] `ci.yml` uses no secrets, and its checkouts keep `persist-credentials: false` (CI). Secrets
      appear only in jobs that run in an environment, each only its own App's key:
      `CANDIDATE_APP_PRIVATE_KEY` in `candidate`, `PROMOTE_APP_PRIVATE_KEY` in `promote`. No other
      environment is used (CI).
- [ ] In `release.yml` the `plan` job has no environment and no secret, its checkout keeps no
      credentials, and the `candidate` job needs it and runs only on its yes (CI).
- [ ] Every downloaded tool is pinned to a version and checked against a SHA-256 (CI).
- [ ] The sign-off, changeset, tooling and gitleaks steps still run, on every pull request, alone
      in their step, and no job or step tolerates failure or is skipped by a condition (CI). A
      skipped required check counts as passing.
- [ ] Job names are unchanged, or `REQUIRED_CHECKS` in `promote.yml` and the `main` ruleset change
      with them.

## Checks and review rules

`scripts/signoff-gate.mjs`, `scripts/changeset-gate.mjs`, `scripts/review-scope.mjs`,
`scripts/workflow-policy.mjs`, their tests, `.github/CODEOWNERS`,
`.github/pull_request_template.md`, `docs/REVIEWING.md`

- [ ] A rule that gets weaker has an owner decision behind it, named in the pull request.
- [ ] Tests change with the rule, and still cover each case that fails.
- [ ] Ownership in `CODEOWNERS` is not narrowed.

## Release tooling

`scripts/` (other files), `.changeset/config.json`

- [ ] Tagging, promotion and rollback behave as `docs/MAINTAINER-SETUP.md` and the release design
      describe: tags are never moved, `release` moves only by fast-forward, candidates are read
      with `git show` and never run.
- [ ] Any external command goes through the runner, so tests can drive it.
- [ ] `scripts/release-plan.mjs` keeps every case in its tests: a pending changeset that releases
      something always runs, even at `0.0.0`; a tag without its GitHub release runs, to repair it;
      a state it cannot read fails the job and is never taken as "nothing to do". It decides only
      whether to run; what to tag stays in `scripts/tag-release.mjs`.

## Dependencies

`package.json`, `package-lock.json`

- [ ] A new or updated dependency is needed, comes from its canonical package, and has a license
      compatible with Apache-2.0.
- [ ] Nothing new ships to users. Install scripts stay off in CI (`npm ci --ignore-scripts`).
- [ ] The lock file changes only as the `package.json` change explains.

## Repository configuration

`.gitleaks.toml`, `.claude-plugin/`, `plugin.json` files, other files under `.github/`

- [ ] A gitleaks exception names an exact file path and a known synthetic match, never a whole file
      or a rule.
- [ ] Manifests keep one version (`npm run -s version:check`), the same owner and author, and
      plugin sources inside this repository.

## Runtime

`plugins/`, `extensions/`

- [ ] RTK trust holds: the binary is checked on every rewrite, the supported version range is
      unchanged unless the pull request is about it, and failures fail closed.
- [ ] No new outbound network request, no new file written outside the plugin's own data folders,
      and no new command run except through the trusted paths.
- [ ] Claude Code and Pi behave the same way, or the difference is in the spec.

## Legal and security documents

`LICENSE`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`

- [ ] `LICENSE` stays the unmodified Apache-2.0 text. A `NOTICE` change has an owner decision.
- [ ] The security contact and the sign-off rules match the owner's decisions.

## The version pull request

Head branch `changeset-release/main`, opened by the candidate App (`context-economy-candidate[bot]`).
One maintainer approves it: the bot pushed last, so the `main` ruleset allows that. GitHub checks
only the branch and the bot's identity, not that the diff is generated, so the approver does.

- [ ] It changes only versions, changelogs and the consumed changesets: every manifest at the new
      version, `CHANGELOG.md`, the deleted changesets, nothing else.
- [ ] Its commits are the App's own (the sign-off gate allows them only there), and no person
      pushed to the branch.
- [ ] On any other change, or a push by a person, do not approve: close it or ask the other
      maintainer.

## Protections outside the repository

Set up by an organization owner with the release setup. Together they stop a pull request from
approving its own change to a check, a workflow or this file:

- `.github/CODEOWNERS` assigns every path to the `southcoltech-labs/maintainers` team. The team
  must be visible and have explicit write access to the repository, or GitHub ignores it as an
  owner. GitHub reads the file from the base branch, so a pull request cannot remove its own
  owners.
- The `main` ruleset requires review from code owners, dismisses approvals when new commits are
  pushed, and requires the last push to be approved by someone other than its author.
- Actions require approval before running workflows from outside contributors.
- Two environments, each limited to deployment branch `main`, with no admin bypass. `candidate`
  holds only the candidate App's key and needs a maintainer's approval, which may be the one who
  merged: a candidate reaches no user who follows the README. `promote` holds only the promote App's key and requires a maintainer other
  than the one who started the run. That check compares with the run's original actor, not a
  re-runner, so a failed promotion is started as a fresh run and never re-run
  (`docs/MAINTAINER-SETUP.md`, "Running a promotion").
- Tag rules: `v*` tags are created only by the candidate App, `promoted-v*` tags only by the
  promote App (`context-economy-release`), and no tag is updated or deleted, with no bypass. Only
  the promote App writes `release`.
