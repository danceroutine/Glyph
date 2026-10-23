import { z } from 'zod';
import { stripVTControlCharacters } from 'node:util';
import { selectElectronTests } from './electron-selection.mjs';

const suiteFile = z.string().regex(/^[^/\\]+\.test\.mjs$/u);
const testIdentity = z.object({ id: z.string().min(1), file: suiteFile, titles: z.array(z.string()).min(1) });
const context = z.object({
  repository: z.string().min(1),
  pullRequest: z.string().regex(/^\d+$/u),
  head: z.string().regex(/^[a-f0-9]{40}$/u),
  base: z.string().regex(/^[a-f0-9]{40}$/u),
  platform: z.string(),
  playwright: z.string(),
});
export const recoveryManifest = z.object({
  version: z.literal(1),
  context,
  run: z.string().regex(/^\d+$/u),
  attempt: z.string().regex(/^\d+$/u),
  passed: z.array(testIdentity),
});
const reportTest = z.object({
  expectedStatus: z.string(),
  projectName: z.literal(''),
  status: z.string(),
  results: z.array(z.object({ status: z.string(), retry: z.number(), errors: z.array(z.unknown()) })),
});
const reportSuite = z.object({
  title: z.string(),
  specs: z.array(z.object({ id: z.string(), file: suiteFile, title: z.string(), tests: z.tuple([reportTest]) })),
  suites: z.array(z.unknown()).default([]),
});

/** @typedef {z.infer<typeof testIdentity> & { expectedStatus: string, status: string, clean: boolean }} TestEvidence */

/** Parse the pinned single-project Playwright JSON format; unknown formats fail closed.
 * @param {unknown} value
 */
export function readElectronReport(value) {
  const report = z
    .object({ config: z.object({ version: z.string() }), suites: z.array(z.unknown()), errors: z.array(z.unknown()) })
    .parse(value);
  // Playwright's normal failure-limit stop emits onError as well as per-test
  // failures. It does not invalidate tests that already completed cleanly.
  const trustworthy = report.errors.every(error => {
    const diagnostic = z.object({ message: z.string() }).strict().safeParse(error);
    return (
      diagnostic.success &&
      /^Testing stopped early after [1-9]\d* maximum allowed failures\.$/u.test(
        stripVTControlCharacters(diagnostic.data.message),
      )
    );
  });
  /** @type {TestEvidence[]} */
  const tests = [];
  /** @param {unknown} node @param {string[]} parents */
  function visit(node, parents) {
    const suite = reportSuite.parse(node);
    for (const spec of suite.specs) {
      const [test] = spec.tests;
      tests.push({
        id: spec.id,
        file: spec.file,
        titles: [...parents, spec.title],
        expectedStatus: test.expectedStatus,
        status: test.status,
        clean:
          trustworthy &&
          test.expectedStatus === 'passed' &&
          test.status === 'expected' &&
          test.results.length === 1 &&
          test.results.every(result => result.status === 'passed' && result.retry === 0 && result.errors.length === 0),
      });
    }
    for (const child of suite.suites) {
      const title = z.object({ title: z.string() }).parse(child).title;
      visit(child, [...parents, title]);
    }
  }
  for (const suite of report.suites) visit(suite, []);
  if (new Set(tests.map(test => test.id)).size !== tests.length) throw new Error('Duplicate Electron test IDs.');
  return { playwright: report.config.version, tests };
}

/** @param {z.infer<typeof testIdentity>} test */
function identity(test) {
  return JSON.stringify([test.id, test.file, test.titles]);
}

export const recoveryPlan = z.object({
  version: z.literal(1),
  context,
  run: z.string(),
  attempt: z.string(),
  sourceRun: z.string().nullable(),
  reason: z.string(),
  required: z.array(testIdentity.extend({ expectedStatus: z.string(), status: z.string(), clean: z.boolean() })),
  reused: z.array(testIdentity),
  remaining: z.array(z.string()),
  execute: z.boolean(),
});

/**
 * Previous evidence is usable only on the same PR/base/platform/toolchain and a
 * verified ancestor. The caller obtains ancestry and changes from Git, not the artifact.
 * @param {{ context: z.infer<typeof context>, run: string, attempt: string, tests: TestEvidence[], previous: unknown, ancestor: boolean, changed: string[], available: string[], rules: { area: string, prefixes: string[], tests: string[] }[] }} input
 */
export function planElectronRecovery(input) {
  const previous = recoveryManifest.safeParse(input.previous);
  let reason = 'No compatible previous evidence; execute the selected tests.';
  /** @type {z.infer<typeof testIdentity>[]} */
  let reused = [];
  let sourceRun = null;
  if (previous.success) {
    const prior = previous.data;
    const keys = /** @type {const} */ (['repository', 'pullRequest', 'base', 'platform', 'playwright']);
    const sameContext = keys.every(key => prior.context[key] === input.context[key]);
    if (sameContext && input.ancestor) {
      const invalidated = selectElectronTests(input.changed, input.available, input.rules);
      const passed = new Set(prior.passed.map(identity));
      reused = input.tests.filter(
        test =>
          test.expectedStatus === 'passed' &&
          passed.has(identity(test)) &&
          !invalidated.tests.includes(`code-oss/tests/electron/${test.file}`),
      );
      sourceRun = prior.run;
      reason =
        invalidated.mode === 'full'
          ? 'Shared or unclassified intervening changes invalidate all prior successes.'
          : 'Reuse clean passes only outside suites invalidated by intervening changes.';
    }
  }
  const reusedIds = new Set(reused.map(test => test.id));
  const remaining = input.tests.filter(test => !reusedIds.has(test.id));
  return recoveryPlan.parse({
    version: 1,
    context: input.context,
    run: input.run,
    attempt: input.attempt,
    sourceRun,
    reason,
    required: input.tests,
    reused,
    remaining: remaining.map(test => test.id),
    execute: remaining.some(test => test.expectedStatus !== 'skipped'),
  });
}

/** Preserve passes from this run and still-valid inherited passes, never flaky/failed/skipped tests.
 * @param {z.infer<typeof recoveryPlan>} plan
 * @param {ReturnType<typeof readElectronReport> | null} report
 */
export function finishElectronRecovery(plan, report) {
  const required = new Map(plan.required.map(test => [identity(test), test]));
  const remaining = new Set(plan.remaining);
  const current =
    report === null || report.playwright !== plan.context.playwright
      ? []
      : report.tests.filter(test => remaining.has(test.id) && required.has(identity(test)));
  const complete =
    !plan.execute ||
    (report !== null &&
      report.playwright === plan.context.playwright &&
      plan.required
        .filter(test => remaining.has(test.id))
        .every(test => current.some(result => identity(result) === identity(test))));
  const passed = [...plan.reused, ...current.filter(test => test.clean)];
  return {
    complete,
    manifest: recoveryManifest.parse({
      version: 1,
      context: plan.context,
      run: plan.run,
      attempt: plan.attempt,
      passed,
    }),
  };
}
