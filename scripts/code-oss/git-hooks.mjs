import { execFileSync } from 'node:child_process';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const huskyMarker = /^#husky \d/m;
const generatedCheckoutTarget = /^cd \.code-oss\/src\s*$/m;

/**
 * Removes only hooks that upstream Husky installed for the generated checkout.
 * Existing project or user hooks are intentionally left untouched.
 */
export async function removeLeakedCodeOssHuskyHooks(repositoryRoot) {
  const hooksRoot = resolve(
    repositoryRoot,
    execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).trim(),
  );
  const entries = await readdir(hooksRoot, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = resolve(hooksRoot, entry.name);
    const contents = await readFile(path, 'utf8');
    if (!huskyMarker.test(contents) || !generatedCheckoutTarget.test(contents)) continue;
    await unlink(path);
    removed.push(entry.name);
  }
  return removed.sort();
}
