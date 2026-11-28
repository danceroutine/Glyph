import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RuleTester } from 'oxlint/plugins-dev';
import plugin from '#scripts/lint/workspace-access.mjs';

// Load the production plugin in the same native Node runtime as the Oxlint CLI.
/** @type {[string, string, boolean][]} */
const fixtures = JSON.parse(readFileSync(0, 'utf8'));
const rule = 'mediated-workspace-access';
const tester = new RuleTester({ cwd: process.cwd() });
const outcomes = fixtures.map(([file, code, denied]) => {
  const filename = resolve(file);
  try {
    tester.run(rule, plugin.rules[rule], {
      valid: denied ? [] : [{ filename, code }],
      invalid: denied ? [{ filename, code, errors: [{ messageId: 'mediated' }] }] : [],
    });
    return [file, null];
  } catch (error) {
    return [file, String(error)];
  }
});
process.stdout.write(JSON.stringify(outcomes));
