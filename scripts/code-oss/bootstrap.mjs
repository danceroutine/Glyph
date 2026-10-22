/**
 * @fileoverview Materializes the exact Code OSS source revision recorded in
 * upstream.json, verifies its archive, then reapplies Glyph's owned overlay.
 * The generated tree is disposable and never becomes a nested repository.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { hasErrorCode } from '#scripts/support/hasErrorCode.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const pin = z
  .looseObject({ tag: z.string(), commit: z.string(), archiveSha256: z.string() })
  .parse(JSON.parse(await readFile(join(repositoryRoot, 'code-oss', 'upstream.json'), 'utf8')));
const generatedRoot = join(repositoryRoot, '.code-oss');
const sourceRoot = join(generatedRoot, 'src');
const archive = join(generatedRoot, `vscode-${pin.tag}.tar.gz`);
const marker = join(sourceRoot, '.glyph-upstream.json');

await mkdir(generatedRoot, { recursive: true });
if (await exists(marker)) {
  // Refuse to mix an existing generated tree with a different reviewed pin.
  const current = z.object({ commit: z.string() }).safeParse(JSON.parse(await readFile(marker, 'utf8')));
  if (!current.success || current.data.commit !== pin.commit)
    throw new Error('The generated Code OSS tree uses another revision. Remove .code-oss and retry.');
} else {
  // Cache the verified archive locally; extraction remains reproducible even
  // when the generated source tree is removed between builds.
  if (!(await exists(archive)) || (await sha256(archive)) !== pin.archiveSha256) {
    const response = await fetch(`https://api.github.com/repos/microsoft/vscode/tarball/${pin.tag}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'glyph-code-oss-bootstrap' },
      redirect: 'follow',
    });
    if (!response.ok)
      throw new Error(`Could not download Code OSS ${pin.tag}: ${response.status} ${response.statusText}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  const actualHash = await sha256(archive);
  if (actualHash !== pin.archiveSha256) throw new Error(`Code OSS archive checksum mismatch: ${actualHash}`);
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', sourceRoot], { stdio: 'inherit' });
  await writeFile(marker, `${JSON.stringify(pin, null, 2)}\n`);
}

execFileSync(process.execPath, [join(repositoryRoot, 'scripts', 'code-oss', 'apply-overlay.mjs')], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
process.stdout.write(`Code OSS ${pin.tag} (${pin.commit}) is ready at ${sourceRoot}\n`);

/** @param {string} path */
async function exists(path) {
  return stat(path).then(
    () => true,
    (/** @type {unknown} */ error) => {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    },
  );
}

/** @param {string} path */
async function sha256(path) {
  /** Hashing the entire archive is the trust check for the generated upstream tree. */
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
