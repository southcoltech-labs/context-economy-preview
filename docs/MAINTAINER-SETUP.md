# Repository setup for releases

These steps are done twice, in the same way: first on the staging repository `southcoltech-labs/context-economy-preview`, once it is public, then on the public repository at publication. Nothing in the release path works until they are done. The release workflow fails at "client-id must be set" until step 2.

**Who does what.** The staging repository belongs to the GitHub organization `southcoltech-labs`, whose owner is Yan Weng. So:
- Yan Weng, as organization owner, does every step that changes settings, and runs the owner checks in step 6.
- The release engineer, with write access to the repository, runs only the collaborator checks.

Nobody shares a login or credentials.

## 0. Staging is public first

The design gates releases and promotions on a protected `release` environment that admits only `main` and waits for the owner's approval. On GitHub, those parts are available as follows ([environment availability](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)):

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

## 2. Release App

1. Under the organization's **Settings → Developer settings → GitHub Apps → New GitHub App**, so that `southcoltech-labs` owns it:
   - Webhook: off.
   - Repository permissions: **Contents** read and write, **Pull requests** read and write, **Checks** read-only, **Metadata** read-only (always on). Nothing else.
   - Where can it be installed: **Only on this account** (the organization).
2. Note the **Client ID**. Generate a **private key**.
3. **Install App → Only select repositories →** the staging repository. At publication, also the public one.
4. Credentials:
   - **Repository variable** `RELEASE_APP_CLIENT_ID` = the Client ID. It is not secret.
   - **Environment secret** `RELEASE_APP_PRIVATE_KEY` = the full `.pem` contents, in the `release` environment (step 3), **never as a repository secret**. A repository secret is readable by any workflow on any branch, which could mint an App token outside the gate. An environment secret is given only to a job that names the environment, after its protections pass ([environment secrets](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
   - Delete any repository-level copy. Keep the `.pem` offline or delete it; a new key can be generated.

The workflows need no change: both jobs name `environment: release` and read `secrets.RELEASE_APP_PRIVATE_KEY`.

## 3. `release` environment

Under **Settings → Environments → New environment**, named `release`:
- **Deployment branches and tags:** selected branches only, with the single rule `main`.
- **Approval:** required reviewers = Yan Weng.
- **Environment secrets:** `RELEASE_APP_PRIVATE_KEY` only.

## 4. Protect `main`

Add a ruleset for `main`, with **no bypass actors**:
- Require a pull request before merging, with at least 1 approval.
- Require these 5 status checks, with the branch up to date. The names must match exactly, as `promote.yml` checks them too:

  ```
  repo checks
  plugins (ubuntu-latest)
  plugins (macos-latest)
  pi (ubuntu-latest)
  pi (macos-latest)
  ```

- Block force pushes. Restrict deletions.

The App's version PR goes through the same checks and review as any pull request.

## 5. Protect `release` and the tags: two layers

A bypass applies to the whole ruleset it is listed in. One ruleset that lets the App create tags would also let it update or delete them ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)). GitHub applies every matching ruleset, so the policy is split. A bypass in one ruleset does not lift the rules of another.

| Ruleset | Target | Rules | Bypass |
| --- | --- | --- | --- |
| `release-write` | branch `release` | Restrict creations, Restrict updates | the release App only |
| `release-fixed` | branch `release` | Block force pushes, Restrict deletions | **none** |
| `tags-create` | tags `v*`, `promoted-v*` | Restrict creations | the release App only |
| `tags-immutable` | tags `v*`, `promoted-v*` | Restrict updates, Restrict deletions, Block force pushes | **none** |

Together:
- only the App creates `release` and moves it, and only by fast-forward;
- only the App creates tags;
- nobody moves or deletes a tag, the App included;
- nobody rewinds, force-pushes or deletes `release`, the App included. The App's fast-forward is the only way it moves.

`promote.mjs` pushes `release` with `--force-with-lease`, which only guards against a concurrent change. GitHub judges the ref change itself: a fast-forward is an update, which `release-write` allows for the App, and anything else is a force push, which `release-fixed` refuses.

If the ruleset UI on this account does not offer the App as a bypass actor, record what it offers and stop. That is a design question, not something to work around.

## 6. Check

**Owner checks** (Yan Weng, read-only), output into the setup record:

```bash
R=<owner>/<repo>
gh api repos/$R/actions/variables/RELEASE_APP_CLIENT_ID --jq .name
gh api repos/$R/actions/secrets --jq '[.secrets[].name]'                          # must be []: no repository copy of the key
gh api repos/$R/environments/release/secrets --jq '[.secrets[].name]'             # ["RELEASE_APP_PRIVATE_KEY"]
gh api repos/$R/environments/release --jq '{protection_rules, deployment_branch_policy}'
gh api repos/$R/environments/release/deployment-branch-policies --jq '[.branch_policies[].name]'   # ["main"]
for id in $(gh api repos/$R/rulesets --jq '.[].id'); do gh api repos/$R/rulesets/$id; done          # full rules and bypass actors
```

**Collaborator checks** (release engineer, read-only), showing the effective rules on each ref:

```bash
gh api repos/$R/rules/branches/main
gh api repos/$R/rules/branches/release
gh api repos/$R/rulesets --jq '.[] | {id, name, target, enforcement}'
```

If one of these is refused for push access, the owner runs it instead.

**Refusal checks.** These push to the repository, so they need separate authorization. Using disposable names the patterns cover, a person must be refused when trying to:
- create the tag `v0.0.0-rulecheck`;
- push to or create `release`;
- push to `main` directly.

The App's permitted actions are checked by the first real release (version PR, candidate tag) and the first promotion (`release` created, then fast-forwarded). Any refusal there is a setup error.

## What happens next

The next push to `main` runs the release workflow with the App. Two changesets are pending:
- a `minor` one for the first preview release;
- a `patch` one for tool-gateway.

So the workflow opens the version PR `0.0.0 → 0.1.0`. When that PR passes the 5 checks and is approved and merged, the workflow tags the candidate `v0.1.0` as a prerelease. E1a then runs on that candidate (`release-proof/E1A-RUNBOOK.md`), and promotion is started by hand.
