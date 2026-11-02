// SPDX-License-Identifier: Apache-2.0

// The repository's workflows meet workflow-policy.mjs, and each way of breaking a rule is caught:
// every case below edits a copy of the real files and must produce the named problem.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workflowProblems } from "./workflow-policy.mjs";

const GITHUB = join(dirname(fileURLToPath(import.meta.url)), "..", ".github");
const WORKFLOWS = Object.fromEntries(
  readdirSync(join(GITHUB, "workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(join(GITHUB, "workflows", f), "utf8")]),
);
const OWNERS = readFileSync(join(GITHUB, "CODEOWNERS"), "utf8");

/** The problems after replacing `from` with `to` once in `file`; the edit must apply. */
function problemsAfter(file, from, to) {
  const text = file === "CODEOWNERS" ? OWNERS : WORKFLOWS[file];
  assert.ok(text.includes(from), `${file} no longer contains: ${from}`);
  const edited = text.replace(from, to);
  return file === "CODEOWNERS" ? workflowProblems(WORKFLOWS, edited) : workflowProblems({ ...WORKFLOWS, [file]: edited }, OWNERS);
}

const SIGNOFF_STEP = "      - name: Commits signed off\n        if: github.event_name == 'pull_request'";
const REPO_JOB = "    name: repo checks\n    runs-on: ubuntu-latest";
const TOOLING = "      - name: Release tooling tests\n        run: npm run -s test:tooling";

test("the workflows and CODEOWNERS meet every rule", () => {
  assert.deepEqual(Object.keys(WORKFLOWS).sort(), ["ci.yml", "promote.yml", "release.yml"]);
  assert.deepEqual(workflowProblems(WORKFLOWS, OWNERS), []);
});

const CASES = [
  ["pull_request_target trigger", "ci.yml", "  pull_request:", "  pull_request_target:", /pull_request_target or workflow_run/],
  ["workflow_run trigger", "release.yml", "  push:", "  workflow_run:", /pull_request_target or workflow_run/],
  ["write permission in ci.yml", "ci.yml", "  contents: read", "  contents: write", /contents: read alone/],
  ["a job widens permissions", "ci.yml", REPO_JOB, `${REPO_JOB}\n    permissions:\n      contents: write`, /sets its own permissions/],
  ["no top-level permissions", "promote.yml", "permissions:\n  contents: read\n", "", /no top-level permissions/],
  ["an action pinned to a tag", "ci.yml", "@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", "@v7 # v7.0.1", /not pinned to a SHA/],
  ["a secret in ci.yml", "ci.yml", "      - run: npm ci --ignore-scripts", "      - run: echo ${{ secrets.X }}", /uses secrets/],
  ["a secret outside the release environment", "release.yml", "    environment: release # protected: deployment branch main only\n", "", /secrets outside the release environment/],
  ["a checkout keeps credentials", "ci.yml", "          persist-credentials: false", "          persist-credentials: true", /keeps its credentials/],
  ["an unchecked download", "ci.yml", "sha256sum -c -", "true", /not checked against a SHA-256/],
  ["a step tolerates failure", "ci.yml", SIGNOFF_STEP, SIGNOFF_STEP.replace("\n", "\n        continue-on-error: true\n"), /continue-on-error/],
  ["the job tolerates failure", "ci.yml", REPO_JOB, `${REPO_JOB}\n    continue-on-error: true`, /continue-on-error/],
  ["the job is skipped", "ci.yml", REPO_JOB, REPO_JOB.replace("\n", "\n    if: false\n"), /skipped required check/],
  ["a shell override on a gate", "ci.yml", SIGNOFF_STEP, `${SIGNOFF_STEP}\n        shell: bash {0}`, /shell or defaults override/],
  ["a defaults override", "ci.yml", "permissions:\n  contents: read", "defaults:\n  run:\n    shell: bash\npermissions:\n  contents: read", /shell or defaults override/],
  ["the gate's command replaced", "ci.yml", "        run: node scripts/signoff-gate.mjs", "        run: echo skipped", /no step runs node scripts\/signoff-gate\.mjs/],
  ["the gate's failure swallowed", "ci.yml", "        run: node scripts/signoff-gate.mjs", "        run: node scripts/signoff-gate.mjs || true", /signoff-gate\.mjs is not run alone/],
  ["the gate turned off", "ci.yml", SIGNOFF_STEP, SIGNOFF_STEP.replace("'pull_request'", "'pull_request' && false"), /signoff-gate\.mjs has condition/],
  ["the gate's head SHA dropped", "ci.yml", "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}", "          HEAD_SHA: HEAD", /head SHA/],
  ["the changeset gate removed", "ci.yml", "        run: node scripts/changeset-gate.mjs", "        run: true", /no step runs node scripts\/changeset-gate\.mjs/],
  ["tooling tests limited to pushes", "ci.yml", TOOLING, TOOLING.replace("\n", "\n        if: github.event_name == 'push'\n"), /test:tooling has condition/],
  ["gitleaks narrowed", "ci.yml", "gitleaks git --config .gitleaks.toml --redact --no-banner .", "gitleaks git --config .gitleaks.toml --redact --no-banner --log-opts=-1 .", /no step runs gitleaks/],
  ["CODEOWNERS narrowed", "CODEOWNERS", "* @southcoltech-labs/maintainers", "/plugins/ @southcoltech-labs/maintainers", /CODEOWNERS: must be exactly/],
  ["CODEOWNERS with an exception", "CODEOWNERS", "* @southcoltech-labs/maintainers", "* @southcoltech-labs/maintainers\n/scripts/ @someone", /CODEOWNERS: must be exactly/],
];

for (const [name, file, from, to, expected] of CASES) {
  test(`caught: ${name}`, () => {
    const problems = problemsAfter(file, from, to);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: got ${JSON.stringify(problems)}`);
  });
}
