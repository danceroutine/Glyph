import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { selectElectronTests } from './electron-selection.mjs';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { base: { type: 'string' }, output: { type: 'string' } } });
/** @param {string[]} args */
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const available = git(['ls-files', '-z', 'code-oss/tests/electron/*.test.mjs']).split('\0').filter(Boolean);
if (available.length === 0) throw new Error('No Electron suites found.');
const { rules } = z
  .object({ rules: z.array(z.object({ area: z.string(), prefixes: z.array(z.string()), tests: z.array(z.string()) })) })
  .parse(JSON.parse(await readFile(new URL('./electron-test-policy.json', import.meta.url), 'utf8')));
let selection;
try {
  if (!values.base) throw new Error('No base revision supplied.');
  const base = git(['rev-parse', '--verify', '--end-of-options', `${values.base}^{commit}`]).trim();
  const mergeBase = git(['merge-base', 'HEAD', base]).trim();
  // --no-renames represents moves as delete+add, so both ownership regions run.
  // NUL separation preserves spaces, tabs, and newlines in tracked paths.
  const changed = git(['diff', '--name-only', '--no-renames', '-z', mergeBase, 'HEAD', '--'])
    .split('\0')
    .filter(Boolean);
  selection = { ...selectElectronTests(changed, available, rules), mergeBase };
} catch {
  selection = {
    mode: 'full',
    tests: available.toSorted((left, right) => left.localeCompare(right)),
    reasons: [{ reason: 'Base history unavailable; run everything.' }],
  };
}
const json = `${JSON.stringify(selection, null, 2)}\n`;
process.stdout.write(json);
if (values.output) {
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(values.output, json);
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `mode=${selection.mode}\ncount=${selection.tests.length}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  // Indented JSON renders paths as plain text, including paths from fork PRs.
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### Electron selection\n\n${json
      .trimEnd()
      .split('\n')
      .map(line => `    ${line}`)
      .join('\n')}\n`,
  );
}
