import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { selectElectronTests } from '#scripts/coverage/electron-selection.mjs';

const directory = 'code-oss/tests/electron/';
const { rules } = /** @type {{ rules: Parameters<typeof selectElectronTests>[2] }} */ (
  JSON.parse(await readFile(new URL('../electron-test-policy.json', import.meta.url), 'utf8'))
);
const available = (await readdir(new URL('../../../code-oss/tests/electron', import.meta.url)))
  .filter(name => name.endsWith('.test.mjs'))
  .map(name => directory + name)
  .toSorted((left, right) => left.localeCompare(right));

describe('Electron test selection', () => {
  it('skips Electron for documentation, unit tests, type tests, and stories', () => {
    const result = selectElectronTests(
      [
        'README.md',
        'docs/test strategy.md',
        'src/chat/tests/Chat.test.ts',
        'scripts/tests/build.test.mjs',
        'code-oss/ui/Button/Button.test-d.ts',
        'code-oss/ui/Button/Button.stories.tsx',
      ],
      available,
      rules,
    );
    expect(result.mode).toBe('skip');
    expect(result.tests).toEqual([]);
    expect(result.reasons).toHaveLength(6);
  });

  it('skips when there are no changed files', () => {
    expect(selectElectronTests([], available, rules)).toEqual({ mode: 'skip', tests: [], reasons: [] });
  });

  it.each(rules)('selects every owned suite for $area, including newly added source files', rule => {
    for (const prefix of rule.prefixes) {
      const result = selectElectronTests([prefix + 'new-source.ts'], available, rules);
      expect(result.mode).toBe('selected');
      expect(result.tests).toEqual(
        rule.tests.map(name => `${directory}${name}.test.mjs`).toSorted((left, right) => left.localeCompare(right)),
      );
      expect(result.tests.length).toBeLessThan(available.length);
    }
  });

  it('unions overlapping rules and deduplicates suites', () => {
    const result = selectElectronTests(['src/web/New.ts'], available, [
      ...rules,
      { area: 'overlap', prefixes: ['src/'], tests: ['GlyphWeb', 'GlyphTodos'] },
    ]);
    expect(result.tests).toEqual([`${directory}GlyphTodos.test.mjs`, `${directory}GlyphWeb.test.mjs`]);
    expect(result.reasons.map(reason => reason.reason)).toEqual(['web tools', 'overlap']);
  });

  it('runs an edited or new Electron suite even alongside documentation', () => {
    const file = `${directory}New.test.mjs`;
    expect(selectElectronTests([file, 'README.md'], [...available, file], rules).tests).toEqual([file]);
  });

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    'native/context-index/src/main.rs',
    'scripts/coverage/electron-test-policy.json',
    'scripts/code-oss/build-ui.mjs',
    'src/chat/AgentRuntime.ts',
    'src/new-feature/Unknown.ts',
    'src/project/prompts/prompt.md',
    'docs/runtime.js',
    'code-oss/ui/design-system/tokens.ts',
    'code-oss/ui/new-component/View.tsx',
    'unusual\npath\t.ts',
  ])('runs everything for shared or unclassified change %s', path => {
    expect(selectElectronTests([path, 'src/web/WebToolRuntime.ts'], available, rules).tests).toEqual(available);
    expect(selectElectronTests([path], available, rules).mode).toBe('full');
  });

  it.each(['GlyphSession.mjs', 'fixtures/example.txt', 'Removed.test.mjs'])(
    'runs everything for changed harness or removed suite %s',
    name => {
      expect(selectElectronTests([directory + name], available, rules).mode).toBe('full');
    },
  );

  it('fails closed if the ownership map references a missing or renamed suite', () => {
    const result = selectElectronTests(['README.md'], [], rules);
    expect(result.mode).toBe('full');
    expect(result.reasons[0].reason).toContain('missing suite');
  });

  it('selects both sides of a rename represented as delete and add', () => {
    expect(selectElectronTests(['src/web/Old.ts', 'src/todos/New.ts'], available, rules).tests).toEqual(
      ['GlyphModeSwitch', 'GlyphPlansAnnotations', 'GlyphTodos', 'GlyphWeb'].map(
        name => `${directory}${name}.test.mjs`,
      ),
    );
  });
});
