import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Documentation integrity only: no child processes, network, sandbox, or test execution.
const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../../..');
const read = path => readFile(path, 'utf8');
const catalog = JSON.parse(await read(resolve(directory, 'coverage.json')));
assert.equal(catalog.safety_policy, '../ADVERSARIAL_TESTING_SAFETY.md');
assert.equal(catalog.source_threat_model, '../../SANDBOX_THREAT_MODEL.md');
const policy = (await read(resolve(directory, catalog.safety_policy))).trim();
const threatModel = await read(resolve(directory, catalog.source_threat_model));
const allowedLanes = new Set(['unit', 'fixture_integration', 'native_canary', 'static_only']);
const vectorIds = [...threatModel.matchAll(/^\|\s+([ALPKO]\d{2})\s*\|/gm)].map(match => match[1]);
const cveIds = [...new Set([...threatModel.matchAll(/CVE-\d{4}-\d+/g)].map(match => match[0]))];
const findingIds = [...threatModel.matchAll(/^### (F\d+) —/gm)].map(match => match[1]);

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label}: duplicate ID`);
  return [...values].sort();
}

function sameIds(actual, expected, label) {
  assert.deepEqual(unique(actual, label), unique(expected, `source ${label}`), `${label}: omitted or unknown ID`);
}

function localPath(path) {
  assert.equal(typeof path, 'string');
  assert.ok(!isAbsolute(path), `Absolute artifact path: ${path}`);
  const resolved = resolve(directory, path);
  const fromRepository = relative(repository, resolved);
  assert.ok(fromRepository !== '..' && !fromRepository.startsWith(`..${sep}`) && !isAbsolute(fromRepository));
  return resolved;
}

assert.equal(catalog.schema_version, 2);
assert.equal(catalog.execution_status, 'proposal_campaign_and_unit_regressions_run');
assert.equal(catalog.threat_model_review_commit, 'a82016548f39b7c2092d8775f753420c46d5d0c9');
assert.equal(catalog.safety_policy_sha256, createHash('sha256').update(policy).digest('hex'));
assert.deepEqual(catalog.agent_models, ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
assert.deepEqual(catalog.prohibited_agent_models, ['gpt-6-astra']);
assert.deepEqual(catalog.campaign_runs, [
  {
    id: 'safe-remediation-2026-10-07',
    source_revision: '2b4e499+working-tree',
    status: 'pass',
    proposal_reviews: { luna: 12, terra: 12, adjudicator: 'gpt-5.6-sol' },
    final_adjudication: 'closed_with_residual_risks',
    remaining_required_changes: 0,
    commands: ['pnpm shell-sandbox:remediation', 'pnpm check', 'pnpm test'],
    evidence: [
      'focused TypeScript regressions: pass',
      'Rust shell-sandbox unit tests: pass',
      'repository checks and ordinary test suites: pass',
    ],
    native_execution: 'not_run',
    native_reason: 'authority contract execution_permission is none',
  },
]);
sameIds(
  catalog.vectors.map(vector => vector.id),
  vectorIds,
  'vectors',
);
sameIds(
  catalog.cves.map(cve => cve.id),
  cveIds,
  'CVEs',
);
sameIds(
  catalog.findings.map(finding => finding.id),
  findingIds,
  'findings',
);
unique(
  catalog.suites.map(suite => suite.id),
  'suites',
);
unique(
  catalog.vectors.map(vector => vector.case_id),
  'cases',
);
assert.equal(catalog.suites.length, 12);

const suiteById = new Map(catalog.suites.map(suite => [suite.id, suite]));
const vectorById = new Map(catalog.vectors.map(vector => [vector.id, vector]));
const operationById = new Map(catalog.native_case_specs.map(operation => [operation.operation_id, operation]));
const controlIds = new Set(catalog.positive_controls.map(control => control.id));
assert.equal(catalog.authority_contract, 'authority-contract.json');
const authority = JSON.parse(await read(resolve(directory, catalog.authority_contract)));
assert.equal(authority.status, 'draft_requires_review');
assert.equal(authority.execution_permission, 'none');
const decisionIds = new Set(authority.exact_capability_decisions.map(decision => decision.id));
assert.ok(catalog.non_closing_states.includes('contract_unresolved'));
assert.ok(catalog.non_closing_states.includes('residual_risk'));
unique(
  catalog.native_case_specs.map(operation => operation.operation_id),
  'native operation designs',
);
unique(
  catalog.vectors.flatMap(vector => vector.platform_cells.map(cell => cell.id)),
  'platform cells',
);
for (const decision of authority.exact_capability_decisions) {
  assert.equal(decision.status, 'contract_unresolved');
  assert.ok(decision.owner_role && decision.scope && decision.reopen_when);
  for (const vectorId of decision.blocks_vectors) assert.ok(vectorById.has(vectorId));
}
for (const operation of catalog.native_case_specs) {
  const vector = vectorById.get(operation.vector_id);
  assert.ok(vector);
  assert.equal(operation.operation_count, 1);
  assert.equal(operation.status, 'planned_not_registered');
  assert.equal(operation.implementation_artifact, null);
  assert.equal(operation.candidate_code_allowed, false);
  assert.deepEqual(operation.closes_findings, []);
  assert.ok(controlIds.has(operation.positive_control_id));
  assert.deepEqual(operation.platforms, vector.platforms);
  assert.ok(vector.native_policy.operations.includes(operation.probe_kind));
  assert.ok(operation.target_slot && operation.target_kind && operation.expected_result);
  assert.ok(operation.variant_ids.length > 0);
  for (const variant of operation.variant_ids) assert.ok(suiteById.get(vector.suite).variants.includes(variant));
  if (operation.vector_id === 'P10') assert.equal(operation.expected_result, 'contract_unresolved');
}
const nativeCases = new Set(['P01', 'P02', 'P04', 'P06', 'P07', 'P09', 'P10', 'P17', 'K14']);
const matrix = await read(resolve(directory, 'COVERAGE.md'));
const specifications = await read(resolve(directory, 'TEST_SPECS.md'));

for (const vector of catalog.vectors) {
  assert.ok(suiteById.has(vector.suite), `${vector.id}: missing suite`);
  assert.equal(vector.case_id, `${vector.suite}-${vector.id}`);
  assert.ok(['planned', 'unit_regression_passed'].includes(vector.status));
  assert.equal(vector.remediation_commit, null);
  assert.ok(Array.isArray(vector.implementation_test_ids));
  assert.ok(Array.isArray(vector.remediation_refs));
  assert.ok(Array.isArray(vector.evidence));
  if (vector.status === 'planned') {
    assert.deepEqual(vector.implementation_test_ids, []);
    assert.deepEqual(vector.remediation_refs, []);
    assert.deepEqual(vector.evidence, []);
  } else {
    assert.ok(vector.implementation_test_ids.length > 0, `${vector.id}: missing regression IDs`);
    assert.ok(vector.remediation_refs.length > 0, `${vector.id}: missing remediation references`);
    assert.deepEqual(vector.evidence, ['campaign:safe-remediation-2026-10-07:unit:pass']);
    for (const testId of vector.implementation_test_ids) {
      const [source] = testId.split('#');
      assert.ok(source && (await stat(resolve(repository, source))).isFile(), `${vector.id}: missing test ${testId}`);
    }
    for (const source of vector.remediation_refs) {
      assert.ok(
        (await stat(resolve(repository, source))).isFile(),
        `${vector.id}: missing remediation source ${source}`,
      );
    }
  }
  assert.ok(vector.case_design.length > 0 && vector.oracle.length > 0);
  assert.ok(vector.allowed_lanes.length > 0);
  assert.ok(vector.platforms.length > 0 && vector.platforms.every(platform => ['macos', 'linux'].includes(platform)));
  for (const decisionId of vector.authority_decision_ids) assert.ok(decisionIds.has(decisionId));
  assert.ok(vector.platform_cells.length > 0);
  const expectedCells = vector.platforms.flatMap(platform =>
    vector.allowed_lanes.filter(lane => lane !== 'native_canary').map(lane => `${vector.case_id}:${platform}:${lane}`),
  );
  for (const operation of catalog.native_case_specs.filter(operation => operation.vector_id === vector.id)) {
    expectedCells.push(
      ...operation.platforms.flatMap(platform =>
        operation.profiles.flatMap(profile =>
          operation.variant_ids.map(variant => `${operation.operation_id}:${platform}:${profile}:${variant}`),
        ),
      ),
    );
  }
  sameIds(
    vector.platform_cells.map(cell => cell.id),
    expectedCells,
    `${vector.id} platform cells`,
  );
  for (const cell of vector.platform_cells) {
    assert.ok(vector.platforms.includes(cell.platform));
    assert.ok(vector.allowed_lanes.includes(cell.lane));
    assert.equal(cell.backend_family, cell.platform === 'macos' ? 'seatbelt' : 'bubblewrap');
    assert.ok(['not_run', 'pass'].includes(cell.status));
    assert.ok(Array.isArray(cell.evidence));
    if (cell.status === 'pass') {
      assert.equal(cell.lane, 'unit', `${cell.id}: only unit evidence ran`);
      assert.equal(vector.status, 'unit_regression_passed');
      assert.ok(cell.evidence.length > 0);
    } else {
      assert.deepEqual(cell.evidence, []);
    }
    if (cell.lane === 'native_canary') {
      const operation = operationById.get(cell.operation_id);
      assert.ok(operation && operation.vector_id === vector.id);
      assert.ok(operation.profiles.includes(cell.profile));
      assert.ok(operation.variant_ids.includes(cell.variant_id));
      assert.equal(cell.expected_result, operation.expected_result);
    } else {
      assert.equal(cell.operation_id, null);
      assert.equal(cell.expected_result_ref, vector.id);
    }
  }
  unique(vector.allowed_lanes, `${vector.id} lanes`);
  for (const lane of vector.allowed_lanes) assert.ok(allowedLanes.has(lane), `${vector.id}: unknown lane ${lane}`);
  assert.equal(
    vector.allowed_lanes.includes('native_canary'),
    nativeCases.has(vector.id),
    `${vector.id}: native ceiling changed`,
  );
  if (nativeCases.has(vector.id)) {
    assert.equal(vector.native_policy.admission, 'requires_independent_controller_review');
    assert.deepEqual(vector.native_policy.platforms, vector.platforms);
    assert.deepEqual(vector.native_policy.profiles, ['read_only', 'workspace_write']);
    assert.ok(vector.native_policy.required_prerequisites.length >= 5);
    assert.ok(
      vector.native_policy.operations.length > 0 &&
        vector.native_policy.operations.every(operation =>
          ['read_synthetic', 'create_marker', 'connect_fixture_loopback'].includes(operation),
        ),
    );
    assert.equal(vector.native_policy.operations.includes('connect_fixture_loopback'), vector.id === 'K14');
  } else {
    assert.equal(vector.native_policy, null);
  }
  assert.ok(matrix.includes(vector.case_id), `${vector.id}: missing readable matrix row`);
}

for (const suite of catalog.suites) {
  sameIds(
    suite.vector_ids,
    catalog.vectors.filter(vector => vector.suite === suite.id).map(vector => vector.id),
    suite.id,
  );
  sameIds(
    suite.findings,
    catalog.findings.filter(finding => finding.suite === suite.id).map(finding => finding.id),
    `${suite.id} findings`,
  );
  assert.equal(suite.status, 'proposal_reviewed');
  assert.ok(specifications.includes(`## ${suite.id} —`), `${suite.id}: missing specification`);
  const prompt = await read(localPath(suite.prompt));
  assert.ok(prompt.includes(policy), `${suite.id}: policy is absent, incomplete, or stale`);
  assert.ok(prompt.includes('Execution mode: `proposal_only`'), `${suite.id}: execution mode missing`);
  assert.ok(prompt.includes('## Required result'), `${suite.id}: output contract missing`);
  for (const vector of catalog.vectors.filter(vector => vector.suite === suite.id)) {
    assert.ok(prompt.includes(vector.case_id), `${vector.id}: missing in prompt`);
  }
  for (const source of suite.sources)
    assert.ok((await stat(resolve(repository, source))).isFile(), `Missing source: ${source}`);
}

for (const finding of catalog.findings) {
  assert.ok(suiteById.has(finding.suite));
  assert.ok(['planned', 'unit_regression_passed'].includes(finding.status));
  assert.equal(finding.remediation_commit, null);
  assert.ok(Array.isArray(finding.regression_test_ids));
  assert.ok(Array.isArray(finding.evidence));
  if (finding.status === 'planned') {
    assert.deepEqual(finding.regression_test_ids, []);
    assert.deepEqual(finding.evidence, []);
  } else {
    assert.ok(finding.regression_test_ids.length > 0, `${finding.id}: missing regression IDs`);
    assert.ok(finding.remediation_refs?.length > 0, `${finding.id}: missing remediation references`);
    assert.deepEqual(finding.evidence, ['campaign:safe-remediation-2026-10-07:unit:pass']);
  }
  assert.ok(finding.primary_vector_ids.length > 0);
  for (const vectorId of finding.primary_vector_ids) assert.ok(vectorById.has(vectorId));
  if (finding.id === 'F2') {
    assert.deepEqual(finding.primary_vector_ids, ['P03']);
    assert.deepEqual(finding.excluded_closure_vector_ids, ['P09', 'P10']);
  }
}

for (const cve of catalog.cves) {
  assert.equal(cve.suite, 'S10');
  assert.equal(cve.lane, 'static_only');
  assert.equal(cve.status, 'unassessed');
  assert.equal(cve.exploit_execution, 'prohibited');
  assert.deepEqual(cve.evidence, []);
  assert.ok(cve.source_urls.length > 0 && cve.source_urls.every(url => url.startsWith('https://')));
  assert.ok(matrix.includes(cve.id), `${cve.id}: missing readable register`);
}

const adjudicator = await read(resolve(directory, 'prompts/adjudicator.md'));
assert.ok(adjudicator.includes(policy), 'Adjudicator: incomplete/stale safety policy');
assert.ok(adjudicator.includes('Execution mode: `proposal_only`'));

let checkedLinks = 0;
for (const base of [directory, resolve(directory, 'prompts')]) {
  for (const name of await readdir(base)) {
    if (!name.endsWith('.md')) continue;
    const document = await read(resolve(base, name));
    for (const [, target] of document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (target.startsWith('https://') || target.startsWith('http://') || target.startsWith('#')) continue;
      assert.ok((await stat(resolve(base, target.split('#')[0]))).isFile(), `${name}: broken local link ${target}`);
      checkedLinks += 1;
    }
  }
}

console.log(
  `Plan valid: ${vectorIds.length} vectors, ${findingIds.length} findings, ${cveIds.length} CVEs, ${catalog.suites.length + 1} complete prompts.`,
);
console.log(
  `Checked ${checkedLinks} local links and exact embedded safety policies. Run pnpm shell-sandbox:remediation for implemented regressions.`,
);
