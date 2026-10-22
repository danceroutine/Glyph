const testDirectory = 'code-oss/tests/electron/';

/**
 * Feature ownership is explicit; everything outside the reviewed rules runs the
 * full suite. Never infer that an unrecognized production change is irrelevant.
 * @param {string[]} changed
 * @param {string[]} available
 * @param {{ area: string, prefixes: string[], tests: string[] }[]} rules
 */
export function selectElectronTests(changed, available, rules) {
  /** @type {Set<string>} */
  const selected = new Set();
  const reasons = [];
  let full = false;
  for (const rule of rules) {
    for (const name of rule.tests) {
      const file = `${testDirectory}${name}.test.mjs`;
      if (!available.includes(file)) {
        full = true;
        reasons.push({ path: file, reason: 'Policy references a missing suite; run everything.' });
      }
    }
  }
  for (const path of changed) {
    if (path.startsWith(testDirectory)) {
      if (available.includes(path)) {
        selected.add(path);
        reasons.push({ path, reason: 'Changed Electron suite.' });
      } else {
        full = true;
        reasons.push({ path, reason: 'Electron harness, fixture, or removed suite; run everything.' });
      }
      continue;
    }
    // Only known non-runtime paths may skip Electron. Runtime Markdown prompts,
    // assets, configuration, dependencies, and native code fall through to full.
    if (
      path === 'README.md' ||
      /^docs\/.*\.md$/u.test(path) ||
      /^(?:src|code-oss|scripts)\/.*\.(?:test\.(?:ts|tsx|mjs)|test-d\.ts|stories\.tsx)$/u.test(path)
    ) {
      reasons.push({ path, reason: 'Documentation or non-Electron test/story; covered by the fast checks.' });
      continue;
    }
    const matches = rules.filter(rule => rule.prefixes.some(prefix => path.startsWith(prefix)));
    if (matches.length === 0) {
      full = true;
      reasons.push({ path, reason: 'Shared infrastructure or unclassified change; run everything.' });
      continue;
    }
    for (const rule of matches) {
      for (const name of rule.tests) selected.add(`${testDirectory}${name}.test.mjs`);
      reasons.push({ path, reason: rule.area });
    }
  }
  const tests = (full ? [...available] : [...selected]).toSorted((left, right) => left.localeCompare(right));
  return { mode: full ? 'full' : tests.length > 0 ? 'selected' : 'skip', tests, reasons };
}
