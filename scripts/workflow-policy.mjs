// SPDX-License-Identifier: Apache-2.0

// The workflow rules of docs/REVIEWING.md ("Workflows") that can be read from the files, run by
// workflow-policy.test.mjs. They run from the pull request's checkout, so a change to them or to
// a workflow still needs review: they catch mistakes, the base-branch code-owner review holds.

/** The file without comments, so a rule is never met or broken by a comment. */
export const code = (text) => text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

/** Each job's text, by job id. */
export function jobs(yml) {
  const body = yml.slice(yml.indexOf("\njobs:\n") + 7);
  return Object.fromEntries(body.split(/\n(?=  [\w-]+:\n)/).map((b) => [b.match(/^ {2}([\w-]+):/)[1], b]));
}

/** Each step's text in a job, split on its `- ` items. */
export const steps = (job) => job.split(/\n(?= {6}- )/).slice(1);

/**
 * The steps of ci.yml's `repo checks` whose failure must fail the job, each with the one
 * condition it may carry. The review-scope step is advisory and handles its own failures
 * (review-scope.mjs), so it needs no failure tolerance either.
 */
export const ENFORCING = [
  ["npm run -s version:check"],
  ["npm run -s test:tooling"],
  ["node scripts/changeset-gate.mjs", "github.event_name == 'pull_request'"],
  ["node scripts/signoff-gate.mjs", "github.event_name == 'pull_request'"],
  ["node scripts/review-scope.mjs", "github.event_name == 'pull_request'"],
  ["node --test scripts/gitleaks-config.test.mjs"],
  ["gitleaks git --config .gitleaks.toml --redact --no-banner ."],
];

export const CODEOWNERS = "* @southcoltech-labs/maintainers";

/**
 * The only environments, and the one secret each may hold: the candidate App's key for the
 * self-approved tagging job, the promote App's key for the two-person promotion. A job that names
 * a secret must be in an environment, and only that environment's secret.
 */
export const ENVIRONMENT_SECRETS = { candidate: "CANDIDATE_APP_PRIVATE_KEY", promote: "PROMOTE_APP_PRIVATE_KEY" };

/** Workflows that hold a secret: contents: read alone at the top, and no job widens it. */
const READ_ONLY = ["promote.yml", "release.yml"];

/** Every rule the workflows (by file name) and CODEOWNERS break, as messages; empty when none. */
export function workflowProblems(workflows, codeowners) {
  const problems = [];
  const fail = (where, what) => problems.push(`${where}: ${what}`);

  for (const [f, text] of Object.entries(workflows)) {
    const yml = code(text);
    if (/^\s*(pull_request_target|workflow_run)\s*:/m.test(yml)) fail(f, "runs on pull_request_target or workflow_run");
    if (!/^permissions:\n {2}\w/m.test(yml)) fail(f, "no top-level permissions");
    for (const line of text.split("\n").filter((l) => /^\s*(- )?uses:/.test(l))) {
      if (!/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d/.test(line)) fail(f, `action not pinned to a SHA: ${line.trim()}`);
    }
    for (const [id, job] of Object.entries(jobs(yml))) {
      const env = job.match(/^ {4}environment:\s*(\S+)\s*$/m)?.[1];
      if (/^ {4}environment:/m.test(job) && !(env in ENVIRONMENT_SECRETS)) fail(`${f} ${id}`, `environment ${env ?? "(not a plain name)"} is not one of ${Object.keys(ENVIRONMENT_SECRETS).join(", ")}`);
      const secrets = [...job.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
      if (secrets.length && !env) fail(`${f} ${id}`, "secrets outside an environment");
      for (const name of secrets.filter((n) => env && n !== ENVIRONMENT_SECRETS[env])) fail(`${f} ${id}`, `secret ${name} in environment ${env}`);
      for (const step of steps(job)) {
        const downloads = step.match(/\b(curl|wget)\b/g)?.length ?? 0;
        if ((step.match(/sha256sum -c/g)?.length ?? 0) < downloads) fail(`${f} ${id}`, "a download is not checked against a SHA-256");
      }
    }
  }

  for (const f of READ_ONLY) {
    const yml = code(workflows[f] ?? "");
    if (!/^permissions:\n {2}contents: read\n(?! {2}\w)/m.test(yml)) fail(f, "permissions are not contents: read alone");
    if ((yml.match(/permissions:/g)?.length ?? 0) > 1) fail(f, "a job sets its own permissions");
  }

  // release.yml: an ungated `plan` job with nothing to leak decides; the candidate job runs only on its yes.
  const release = jobs(code(workflows["release.yml"] ?? ""));
  const plan = release.plan ?? "";
  if (!plan) fail("release.yml", "no plan job");
  if (/^ {4}environment:/m.test(plan) || /secrets\./.test(plan)) fail("release.yml plan", "has an environment or a secret");
  for (const step of steps(plan).filter((s) => /uses: actions\/checkout@/.test(s))) {
    if (!/persist-credentials: false/.test(step)) fail("release.yml plan", "a checkout keeps its credentials");
  }
  if (!steps(plan).some((s) => /^ {8}run: node scripts\/release-plan\.mjs\s*$/m.test(s) && /^ {8}id: plan\s*$|^ {6}- id: plan\s*$/m.test(s))) {
    fail("release.yml plan", "no step `plan` runs node scripts/release-plan.mjs alone");
  }
  for (const [id, job] of Object.entries(release)) {
    if (!/^ {4}environment:\s*candidate\s*$/m.test(job)) continue;
    if (!/^ {4}needs: plan\s*$/m.test(job)) fail(`release.yml ${id}`, "does not need the plan job");
    if (!/^ {4}if: needs\.plan\.outputs\.run == 'true'\s*$/m.test(job)) fail(`release.yml ${id}`, "does not run only on the plan's yes");
  }

  const ci = code(workflows["ci.yml"] ?? "");
  if (!/^on:\n {2}pull_request:/m.test(ci)) fail("ci.yml", "does not run on pull requests");
  if (!/^permissions:\n {2}contents: read\n(?! {2}\w)/m.test(ci)) fail("ci.yml", "permissions are not contents: read alone");
  if ((ci.match(/permissions:/g)?.length ?? 0) > 1) fail("ci.yml", "a job sets its own permissions");
  if (/secrets\./.test(ci)) fail("ci.yml", "uses secrets");
  if (/continue-on-error/.test(ci)) fail("ci.yml", "continue-on-error: a required check would stay green on a failure");
  if (/^\s*(shell|defaults):/m.test(ci)) fail("ci.yml", "a shell or defaults override can swallow exit codes");
  const ciJobs = jobs(ci);
  for (const [id, job] of Object.entries(ciJobs)) {
    if (/^ {4}if:/m.test(job)) fail(`ci.yml ${id}`, "job condition: a skipped required check counts as passing");
    for (const step of steps(job).filter((s) => /uses: actions\/checkout@/.test(s))) {
      if (!/persist-credentials: false/.test(step)) fail(`ci.yml ${id}`, "a checkout keeps its credentials");
    }
  }
  const repo = steps(ciJobs.repo ?? "");
  for (const [cmd, cond] of ENFORCING) {
    const step = repo.find((s) => s.includes(cmd));
    if (!step) {
      fail("ci.yml repo", `no step runs ${cmd}`);
      continue;
    }
    const runs = step.match(/^ {8}run: (.*?)\s*$/m)?.[1];
    if (runs !== cmd) fail("ci.yml repo", `${cmd} is not run alone (${runs ?? "multi-line run"})`);
    const has = step.match(/^ {8}if: (.+?)\s*$/m)?.[1];
    if (has !== cond) fail("ci.yml repo", `${cmd} has condition ${has ?? "none"}, expected ${cond ?? "none"}`);
  }
  const signoff = repo.find((s) => s.includes("node scripts/signoff-gate.mjs")) ?? "";
  if (!/HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/.test(signoff)) fail("ci.yml repo", "the sign-off gate does not read the pull request's head SHA");

  const owners = code(codeowners ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (owners.length !== 1 || owners[0] !== CODEOWNERS) fail("CODEOWNERS", `must be exactly "${CODEOWNERS}"`);
  return problems;
}
