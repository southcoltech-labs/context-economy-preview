# Repository setup for releases

These steps are done twice, in the same way: first on the staging repository `southcoltech-labs/context-economy-preview`, once it is public, then on the public repository at publication. Nothing in the release path works until they are done. The release workflow fails at "client-id must be set" until step 2. A repository set up with the earlier single release App moves to this setup by [step 8](#8-moving-from-one-release-app).

**Who does what.** Both repositories belong to the GitHub organization `southcoltech-labs`. So:
- An organization owner does every step that changes settings, and runs the owner checks in step 7.
- The release engineer, with write access to the repository, runs only the collaborator checks.

Nobody shares a login or credentials.

## 0. Staging is public first

The design gates candidates and promotions on two protected environments, `candidate` and `promote`, that admit only `main` and wait for a maintainer's approval (on `promote`, another maintainer's). On GitHub, those parts are available as follows ([environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)):

| Capability | Public repository | Private, Free | Private, paid plan (Pro or Team) |
| --- | --- | --- | --- |
| Environments and environment secrets | yes | no | yes |
| Deployment branch rule (`main` only) | yes | no | yes |
| Required reviewers (approval) | yes | no | **no** |
| Branch protection and rulesets | yes | no | yes |

Staging is public, on GitHub Free: a public repository provides every row, required reviewers included, with no plan change. So:

- **Nothing below starts until staging is public.** Making it public is a publication. It happens only after a pre-publication review is recorded, and the owner has done a final review and explicitly approved that repository at that SHA. The owner flips the visibility.
- **On a private repository, stop here.** Its rulesets return 403 on Free, and on Pro it still lacks required reviewers. Do not configure a partial gate, and do not drop approval.

## 1. Plan

None. GitHub Free is enough for a public repository.

## 2. Two Apps

One App makes candidates, the other promotes them, so a key that a single maintainer can unlock never moves `release`. An organization owner creates both under the organization's **Settings → Developer settings → GitHub Apps → New GitHub App**, so that `southcoltech-labs` owns them. For each: webhook off; **Where can it be installed: Only on this account**; **Metadata** read-only (always on).

| App | Role | Repository permissions | Workflow, environment |
| --- | --- | --- | --- |
| `context-economy-candidate` | opens the version PR, creates `v<version>` tags and their prereleases | **Contents** read and write, **Pull requests** read and write. Nothing else | `release.yml`, `candidate` |
| `context-economy-release` | moves `release`, creates `promoted-v<version>` tags, marks the release latest | **Contents** read and write, **Checks** read-only. Nothing else | `promote.yml`, `promote` |

Then, for each App:
1. Note the **Client ID**. **Install App → Only select repositories →** the staging repository. At publication, also the public one.
2. Repository variables, which are not secret:
   - `CANDIDATE_APP_CLIENT_ID` and `PROMOTE_APP_CLIENT_ID` = the Client IDs.
   - `CANDIDATE_BOT_EMAIL` and `PROMOTE_BOT_EMAIL` = `<bot id>+<app slug>[bot]@users.noreply.github.com`, each bot's no-reply address, with the id from `gh api 'users/<app slug>[bot]' --jq .id`. The sign-off gate lets the version PR's commits through only when their author is `CANDIDATE_BOT_EMAIL`; `release.yml` tags as the candidate bot and `promote.yml` as the promote bot. Each workflow fails until its address is set.
3. **Don't generate the private keys yet.** Both keys are generated and stored in step 6, after the environments (step 3), `main` (step 4), and `release` and the tags (step 5) are protected and read back. A usable candidate key before then would give a self-approved job a write token with no ruleset limiting it, and saving an environment secret before its environment exists would create the environment with no protections.

The candidate App's `contents: write` is not limited to candidate tags: it can also edit any release's prerelease and latest flags, push to unprotected branches and edit pull requests. The rulesets in step 5 stop it at `release`, `promoted-v*`, existing tags and `main`. The owner accepted that remaining reach on 2026-11-12: it changes what the releases page shows, not what installs follow.

## 3. Maintainers team and the two environments

**The team first.** The environments' reviewers (here) and `CODEOWNERS` (step 4) both name `southcoltech-labs/maintainers`, and GitHub ignores a code owner without an explicit write grant on the repository. An organization owner:
- creates the team `maintainers` under the organization's **Teams**, with visibility **Visible**, and the organization's owners as its members;
- grants it **Write** under the repository's **Settings → Collaborators and teams**.

Check, read-only, before going on:

```bash
R=<owner>/<repo>
gh api orgs/southcoltech-labs/teams/maintainers --jq .privacy                                     # closed (visible)
gh api -H 'Accept: application/vnd.github.v3.repository+json' orgs/southcoltech-labs/teams/maintainers/repos/$R --jq '{role_name, push: .permissions.push}'   # write, true; without the header, an empty 204
gh api repos/$R/codeowners/errors                                                                 # {"errors":[]}
```

**The environments.** Under **Settings → Environments → New environment**, before any workflow names them (a workflow that names a missing environment makes GitHub create it with no protections):

| | `candidate` | `promote` |
| --- | --- | --- |
| Deployment branches and tags | selected branches only, the single rule `main` | the same |
| Required reviewers | the team `southcoltech-labs/maintainers` | the same |
| Prevent self-review | **off**: whoever merged into `main` approves their own run. A candidate reaches no user who follows the README | **on**: whoever started the promotion can't approve it |
| Allow administrators to bypass | off | off |

Read both back, before any secret:

```bash
for E in candidate promote; do gh api repos/$R/environments/$E --jq '{name, can_admins_bypass, protection_rules, deployment_branch_policy}'; gh api repos/$R/environments/$E/deployment-branch-policies --jq '[.branch_policies[].name]'; done
```

Expected for each: `can_admins_bypass: false`; `protection_rules` with `branch_policy` and `required_reviewers` = the team; custom branch policies, `main` only. `prevent_self_review` is `false` on `candidate` and `true` on `promote`.

**No key yet.** The keys are stored in step 6, after `main`, `release` and the tags are protected too.

`release.yml` runs its first job, `plan`, with no environment and no secret. It reads the release state and starts the `candidate` job only when there is a version PR to open or update, a candidate to tag, or a missing GitHub release to repair. A merge with nothing to release asks for no approval.

## 4. Protect `main`

Add a ruleset for `main`, with **no bypass actors**:
- Require a pull request before merging, with at least 1 approval; dismiss stale approvals when new commits are pushed; require review from Code Owners; require approval of the most recent reviewable push. Allowed merge methods: squash and rebase.
- Require linear history.
- Require these 5 status checks from GitHub Actions, with the branch up to date. The names must match exactly, as `promote.yml` checks them too:

  ```
  repo checks
  plugins (ubuntu-latest)
  plugins (macos-latest)
  pi (ubuntu-latest)
  pi (macos-latest)
  ```

- Also require the `DCO` check, with the DCO App as its source. Install the App from **github.com/apps/dco → Only select repositories →** this repository, and add no `.github/dco.yml`: its default requires sign-off from organization members too. The check appears only after the App has reported on a first pull request; add it then. `promote.yml` doesn't list it: it is a pull-request check, and `repo checks` enforces the same sign-off rule.
- Block force pushes. Restrict deletions.

The candidate App's version PR goes through the same checks as any pull request. One maintainer approves it, as `docs/REVIEWING.md` "The version pull request" describes: the bot pushed last, so the most-recent-push rule is met.

## 5. Protect `release` and the tags: two layers

A bypass applies to the whole ruleset it is listed in. One ruleset that lets an App create tags would also let it update or delete them ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)). GitHub applies every matching ruleset, so the policy is split. A bypass in one ruleset does not lift the rules of another.

| Ruleset | Target | Rules | Bypass |
| --- | --- | --- | --- |
| `release-write` | branch `release` | Restrict creations, Restrict updates | `context-economy-release` only |
| `release-fixed` | branch `release` | Block force pushes, Restrict deletions | **none** |
| `tags-create-candidate` | tags `v*` | Restrict creations | `context-economy-candidate` only |
| `tags-create-promoted` | tags `promoted-v*` | Restrict creations | `context-economy-release` only |
| `tags-immutable` | tags `v*`, `promoted-v*` | Restrict updates, Restrict deletions, Block force pushes | **none** |

A ruleset pattern is matched against the whole ref (`refs/tags/v*`), so `v*` covers `v0.1.2` and not `promoted-v0.1.2`. The refusal checks in step 7 confirm it.

Together:
- only the promote App creates `release` and moves it, and only by fast-forward;
- only the candidate App creates `v*` tags, and only the promote App creates `promoted-v*` tags;
- nobody moves or deletes a tag, either App included;
- nobody rewinds, force-pushes or deletes `release`, either App included. The promote App's fast-forward is the only way it moves.

`promote.mjs` pushes `release` with `--force-with-lease`, which only guards against a concurrent change. GitHub judges the ref change itself: a fast-forward is an update, which `release-write` allows for the promote App, and anything else is a force push, which `release-fixed` refuses.

If the ruleset UI on this account does not offer an App as a bypass actor, record what it offers and stop. That is a design question, not something to work around.

Read every ruleset back, `main`'s included, before going on:

```bash
for id in $(gh api repos/$R/rulesets --jq '.[].id'); do gh api repos/$R/rulesets/$id --jq '{name, target, enforcement, conditions, rules: [.rules[].type], bypass_actors}'; done
```

Expected: the `main` ruleset of step 4 and the five rulesets of the table above, each `active`, with exactly the bypass actors listed.

## 6. Keys, last

Only once step 3's environments and step 5's rulesets (with `main`'s from step 4) read back as expected. Until then neither App can get a token, so no self-approved job can write anything.

- Generate a private key for `context-economy-candidate` and store it as the **environment secret** `CANDIDATE_APP_PRIVATE_KEY` in `candidate` only.
- Generate a private key for `context-economy-release` and store it as the **environment secret** `PROMOTE_APP_PRIVATE_KEY` in `promote` only.
- **Never as a repository secret**, and never one key in both environments. A repository secret is readable by any workflow on any branch, which could mint an App token outside the gate. An environment secret is given only to a job that names the environment, after its protections pass ([environment secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). Each environment holds no other secret; `scripts/workflow-policy.mjs` fails CI if a workflow reads any other secret, or one in the wrong environment.
- Keep no copy of either `.pem`, or keep it offline; a new key can be generated.

## 7. Check

**Owner checks** (an organization owner, read-only), output into the setup record:

```bash
R=<owner>/<repo>
for V in CANDIDATE_APP_CLIENT_ID PROMOTE_APP_CLIENT_ID; do gh api repos/$R/actions/variables/$V --jq .name; done
for V in CANDIDATE_BOT_EMAIL PROMOTE_BOT_EMAIL; do gh api repos/$R/actions/variables/$V --jq .value; done   # <bot id>+<app slug>[bot]@users.noreply.github.com, one per App
gh api repos/$R/actions/secrets --jq '[.secrets[].name]'                          # must be []: no repository copy of a key
gh api repos/$R/environments --jq '[.environments[].name]'                        # ["candidate","promote"], plus an empty "release" kept after step 8
gh api repos/$R/environments/release/secrets --jq '[.secrets[].name]'             # only if "release" was kept: []
gh api repos/$R/environments/candidate/secrets --jq '[.secrets[].name]'           # ["CANDIDATE_APP_PRIVATE_KEY"]
gh api repos/$R/environments/promote/secrets --jq '[.secrets[].name]'             # ["PROMOTE_APP_PRIVATE_KEY"]
for E in candidate promote; do gh api repos/$R/environments/$E --jq '{name, can_admins_bypass, protection_rules}'; gh api repos/$R/environments/$E/deployment-branch-policies --jq '[.branch_policies[].name]'; done   # false; reviewers the team; prevent_self_review false, true; ["main"]
gh api orgs/southcoltech-labs/teams/maintainers --jq .privacy                                     # closed
gh api -H 'Accept: application/vnd.github.v3.repository+json' orgs/southcoltech-labs/teams/maintainers/repos/$R --jq '{role_name, push: .permissions.push}'   # write, true; without the header, an empty 204
gh api repos/$R/codeowners/errors                                                                 # {"errors":[]}
for id in $(gh api repos/$R/rulesets --jq '.[].id'); do gh api repos/$R/rulesets/$id; done          # full rules and bypass actors, as the table in step 5
```

**Collaborator checks** (release engineer, read-only), showing the effective rules on each ref:

```bash
gh api repos/$R/rules/branches/main
gh api repos/$R/rules/branches/release
gh api repos/$R/rulesets --jq '.[] | {id, name, target, enforcement}'
```

If one of these is refused for push access, the owner runs it instead.

**Refusal checks.** These push to the repository, so they need separate authorization, and are made with the company identity or a disposable one. Using disposable names the patterns cover, a person must be refused when trying to:
- create the tag `v0.0.0-rulecheck` or `promoted-v0.0.0-rulecheck`;
- push to or create `release`;
- push to `main` directly.

Each App's refusals (the candidate App writing `release` or creating a `promoted-v*` tag; the promote App creating a `v*` tag; either updating a tag or pushing to `main`) are checked on staging as separately approved exercises. The permitted actions are checked by the first real release (version PR, candidate tag, prerelease) and the first promotion. Any refusal there is a setup error.

## 8. Moving from one release App

A repository first set up with one App, `context-economy-release`, holding its key in an environment named `release` and bypassing a single `tags-create` ruleset for `v*` and `promoted-v*`, moves to the setup above in this order. It fails closed: at no point can the candidate App's key reach `release` or `promoted-v*`, and no environment exists without its protections. Each settings change is approved by the owner on its own.

1. **The pull request** that splits the workflows is reviewed and approved, and **not merged**.
2. **Candidate freeze, then Apps and tag rules.** First check that no `release.yml` run is in progress or waiting and no version PR is about to merge. Create `context-economy-candidate` (step 2) and add its variables. `context-economy-release` stays the promote App; add `PROMOTE_APP_CLIENT_ID` and `PROMOTE_BOT_EMAIL` (its existing values). Add `tags-create-candidate` and `tags-create-promoted` (step 5). Keep the old `tags-create` until item 6. GitHub applies every matching ruleset, so from here until item 6 **neither App can create a `v*` tag**; `promoted-v*` still works for the promote App. During the freeze no version PR is merged and no tagging run is approved; a version PR may still be opened or updated. A refused tag write is run again only after item 6, with the owner's approval. Read every ruleset back.
3. **Environments, protections first.** Create `candidate` and `promote` (step 3) and read both back.
4. **Keys last.** Generate the candidate App's key into `candidate`. Generate a **new** key for `context-economy-release` into `promote`. Store neither anywhere else.
5. **Merge** the pull request.
6. **Remove the old setup, then read back.** Delete the secret `RELEASE_APP_PRIVATE_KEY` from the `release` environment; in the App's settings, delete `context-economy-release`'s previous private key; delete the variables `RELEASE_APP_CLIENT_ID` and `RELEASE_BOT_EMAIL`; delete the old `tags-create` ruleset. The emptied `release` environment may stay for its deployment history: it holds no secret, and `scripts/workflow-policy.mjs` fails CI if a workflow names it. Run the owner checks of step 7; `release` then lists no secrets. The freeze ends here.

## What happens next

On a new repository, the next push to `main` runs `release.yml`. Pending changesets make its `plan` job start the `candidate` job, which opens the version PR. When that PR passes the required checks and one maintainer approves and merges it, `plan` finds the new version untagged, and the `candidate` job, approved by whoever merged, tags the candidate `v<version>` as a prerelease. E1a then runs on that candidate (`release-proof/E1A-RUNBOOK.md`), and promotion is started by hand and approved by the other maintainer.

## Running a promotion

A maintainer starts **Actions → promote → Run workflow** from `main`, with the candidate's tag, for example `v0.1.2`, once its E1a proof is on `main`. The run waits in the `promote` environment until **the other maintainer** approves it.

**A promotion that did not succeed is started again as a fresh run, never with "Re-run".** This covers a run that failed, was cancelled, was rejected at approval or timed out waiting for it; such a run stays re-runnable in the Actions history for about 30 days. GitHub's "Prevent self-review" compares the approver with the run's original actor, not with whoever re-runs it: if one maintainer starts a promotion and the other re-runs it, the re-runner can approve their own re-run, and one person has promoted alone. This is a known limit of the setting, accepted by the owner and not enforced by GitHub, so it is held by this procedure:
- never use **Re-run all jobs** or **Re-run failed jobs** on a `promote` run that did not succeed; leave it as it is;
- start a new run with **Run workflow** and the same tag; the other maintainer approves it, as for the first run;
- the new run completes whatever is missing: `promote.mjs` checks the same candidate, moves `release` only by fast-forward if it has not moved, and creates `promoted-v<version>` and marks the release latest if those are missing. It never moves or recreates a tag.

Re-running a promotion that succeeded changes nothing: `promote.mjs` finds the work done. A promotion that was re-run after a failure anyway is reported to the other maintainer and recorded.

**Owner decision (2026-11-12).** This rule is kept as a procedure, not enforced by the workflow. The remaining risk is accepted: a maintainer who re-runs the other's unsuccessful run can approve it alone, but only for a candidate that passes the same checks (tag, CI, E1a proof, fast-forward to a newer version), and the re-run uses the workflow code of the original run's commit. A guard in `promote.yml` that refuses any `github.run_attempt` other than 1 was considered and declined; it is the fallback if the procedure proves insufficient.
