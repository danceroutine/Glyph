import { describe, expect, it } from 'vitest';
import {
  finishElectronRecovery,
  planElectronRecovery,
  readElectronReport,
} from '#scripts/coverage/electron-recovery.mjs';

const context = {
  repository: 'owner/repo',
  pullRequest: '8',
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  platform: 'Linux-X64',
  playwright: '1.61.1',
};
const rules = [{ area: 'web', prefixes: ['src/web/'], tests: ['GlyphWeb'] }];
const evidence = (id = 'web', file = 'GlyphWeb.test.mjs') => ({
  id,
  file,
  titles: ['group', id],
  expectedStatus: 'passed',
  status: 'expected',
  clean: true,
});
const tests = [evidence(), evidence('chat', 'GlyphChats.test.mjs')];
const previous = (passed = tests) => ({ version: 1, context, run: '1', attempt: '1', passed });
const input = (extra = {}) => ({
  context,
  run: '2',
  attempt: '1',
  tests,
  previous: previous(),
  ancestor: true,
  changed: [],
  available: tests.map(test => `code-oss/tests/electron/${test.file}`),
  rules,
  ...extra,
});
function report(extra = {}) {
  return {
    config: { version: context.playwright },
    errors: [],
    suites: [
      {
        title: 'GlyphWeb.test.mjs',
        specs: [],
        suites: [
          {
            title: 'group',
            specs: [
              {
                id: 'web',
                file: 'GlyphWeb.test.mjs',
                title: 'web',
                tests: [
                  {
                    projectName: '',
                    expectedStatus: 'passed',
                    status: 'expected',
                    results: [{ status: 'passed', retry: 0, errors: [] }],
                    ...extra,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('Electron recovery evidence', () => {
  it('reads complete identities and only clean first-attempt passes', () => {
    expect(readElectronReport(report())).toEqual({ playwright: context.playwright, tests: [evidence()] });
  });
  it.each([
    { expectedStatus: 'skipped' },
    { status: 'flaky' },
    { results: [] },
    { results: [{ status: 'failed', retry: 0, errors: [] }] },
    { results: [{ status: 'passed', retry: 1, errors: [] }] },
    { results: [{ status: 'passed', retry: 0, errors: ['teardown failed'] }] },
    {
      results: [
        { status: 'failed', retry: 0, errors: [] },
        { status: 'passed', retry: 1, errors: [] },
      ],
    },
  ])('does not reuse skipped, flaky, failed, retried, or incomplete results: %j', extra => {
    expect(readElectronReport(report(extra)).tests[0].clean).toBe(false);
  });
  it('does not reuse results from a report with global errors', () => {
    expect(readElectronReport({ ...report(), errors: ['global teardown failed'] }).tests[0].clean).toBe(false);
  });
  it.each([
    'Testing stopped early after 10 maximum allowed failures.',
    '\u001B[31mTesting stopped early after 10 maximum allowed failures.\u001B[39m',
  ])('retains completed clean passes when Playwright stops at its failure limit: %s', message => {
    expect(readElectronReport({ ...report(), errors: [{ message }] }).tests[0].clean).toBe(true);
  });
  it.each([
    { errors: [{ message: 'global teardown failed' }] },
    { errors: [{ message: 'Testing stopped early after 10 maximum allowed failures.', stack: 'unexpected error' }] },
    {
      errors: [
        { message: 'Testing stopped early after 10 maximum allowed failures.' },
        { message: 'global teardown failed' },
      ],
    },
  ])('still rejects actual global errors alongside or instead of the cutoff: %j', ({ errors }) => {
    expect(readElectronReport({ ...report(), errors }).tests[0].clean).toBe(false);
  });
  it('rejects malformed reports, multiple projects, unsafe files, and duplicate IDs', () => {
    expect(() => readElectronReport({})).toThrow();
    expect(() => readElectronReport(report({ projectName: 'new project' }))).toThrow();
    const duplicate = report();
    duplicate.suites.push(...duplicate.suites);
    expect(() => readElectronReport(duplicate)).toThrow('Duplicate Electron test IDs');
    const unsafe = report();
    unsafe.suites[0].suites[0].specs[0].file = '../outside.test.mjs';
    expect(() => readElectronReport(unsafe)).toThrow();
  });
});

describe('recovery selection', () => {
  it('reuses unchanged passes and executes only a previous failure', () => {
    const plan = planElectronRecovery(input({ previous: previous([tests[0]]) }));
    expect(plan.reused.map(test => test.id)).toEqual(['web']);
    expect(plan.remaining).toEqual(['chat']);
    expect(plan.execute).toBe(true);
    expect(plan.sourceRun).toBe('1');
  });
  it('skips execution explicitly when every active test has valid evidence', () => {
    expect(planElectronRecovery(input())).toMatchObject({ remaining: [], execute: false });
  });
  it('reruns successes in affected features while retaining unrelated evidence', () => {
    const plan = planElectronRecovery(input({ changed: ['src/web/Fetch.ts'] }));
    expect(plan.remaining).toEqual(['web']);
    expect(plan.reused.map(test => test.id)).toEqual(['chat']);
  });
  it('invalidates a changed test file, including renames and added cases', () => {
    expect(planElectronRecovery(input({ changed: ['code-oss/tests/electron/GlyphWeb.test.mjs'] })).remaining).toEqual([
      'web',
    ]);
  });
  it.each([
    'src/shared/helper.ts',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'native/shell-sandbox/src/lib.rs',
    'code-oss/tests/electron/GlyphSession.mjs',
  ])('invalidates all successes for %s', path => {
    const plan = planElectronRecovery(input({ changed: [path] }));
    expect(plan.reused).toEqual([]);
    expect(plan.reason).toContain('invalidate all');
  });
  it('preserves successes after documentation changes', () => {
    expect(planElectronRecovery(input({ changed: ['docs/test-selection.md'] })).execute).toBe(false);
  });
  it.each(['repository', 'pullRequest', 'base', 'platform', 'playwright'])('rejects incompatible %s', key => {
    expect(
      planElectronRecovery(
        input({
          context: { ...context, [key]: key === 'base' ? 'c'.repeat(40) : key === 'pullRequest' ? '9' : 'different' },
        }),
      ).reused,
    ).toEqual([]);
  });
  it.each([null, {}, { ...previous(), version: 2 }])(
    'falls back when previous evidence is absent or invalid: %j',
    value => {
      expect(planElectronRecovery(input({ previous: value })).reused).toEqual([]);
    },
  );
  it('rejects force-pushed or unavailable history', () => {
    expect(planElectronRecovery(input({ ancestor: false })).reused).toEqual([]);
  });
  it('does not reuse new, renamed, or identity-mismatched tests, or expected skips', () => {
    const plan = planElectronRecovery(
      input({
        tests: [
          evidence('new'),
          { ...evidence(), titles: ['renamed'] },
          { ...evidence('chat', 'GlyphChats.test.mjs'), expectedStatus: 'skipped' },
        ],
      }),
    );
    expect(plan.reused).toEqual([]);
    expect(plan.remaining).toEqual(['new', 'web', 'chat']);
  });
  it('does not launch Electron for only pending contracts', () => {
    expect(planElectronRecovery(input({ tests: [{ ...evidence(), expectedStatus: 'skipped' }] })).execute).toBe(false);
  });
});

describe('recovery completion', () => {
  it('carries validated passes forward and records newly passing tests', () => {
    const plan = planElectronRecovery(input({ previous: previous([tests[1]]) }));
    const result = finishElectronRecovery(plan, readElectronReport(report()));
    expect(result.complete).toBe(true);
    expect(result.manifest.passed.map(test => test.id)).toEqual(['chat', 'web']);
    expect(result.manifest.run).toBe('2');
  });
  it('retains valid inherited passes when execution is interrupted', () => {
    const plan = planElectronRecovery(input({ previous: previous([tests[1]]) }));
    expect(finishElectronRecovery(plan, null)).toMatchObject({
      complete: false,
      manifest: { passed: [expect.objectContaining({ id: 'chat' })] },
    });
  });
  it('accepts a fully reused run without a new report', () => {
    expect(finishElectronRecovery(planElectronRecovery(input()), null).complete).toBe(true);
  });
  it('does not accept unrelated or missing outcomes as evidence', () => {
    const plan = planElectronRecovery(input({ previous: null }));
    expect(
      finishElectronRecovery(plan, { playwright: context.playwright, tests: [evidence('unrequested')] }),
    ).toMatchObject({ complete: false, manifest: { passed: [] } });
    expect(finishElectronRecovery(plan, readElectronReport(report())).complete).toBe(false);
  });
  it('records failed or flaky execution as attempted but not reusable', () => {
    const plan = planElectronRecovery(input({ tests: [evidence()], previous: null }));
    expect(finishElectronRecovery(plan, readElectronReport(report({ status: 'flaky' })))).toMatchObject({
      complete: true,
      manifest: { passed: [] },
    });
  });
  it('rejects a mismatched runtime report', () => {
    const plan = planElectronRecovery(input({ tests: [evidence()], previous: null }));
    expect(finishElectronRecovery(plan, { playwright: 'different', tests: [evidence()] })).toMatchObject({
      complete: false,
      manifest: { passed: [] },
    });
  });
});
