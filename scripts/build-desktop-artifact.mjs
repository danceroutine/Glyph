/**
 * @fileoverview Packages the utility-host JavaScript, production dependencies,
 * and native helpers as one auditable artifact consumed by Code OSS.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifactsRoot = join(repositoryRoot, '.artifacts');
const staging = join(artifactsRoot, 'glyph-desktop-host');
const deployment = join(artifactsRoot, '.glyph-desktop-host-deploy');
const archive = join(artifactsRoot, 'glyph-desktop-host.tgz');
const sourcePackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const codeOssPin = JSON.parse(await readFile(join(repositoryRoot, 'code-oss', 'upstream.json'), 'utf8'));

await rm(staging, { recursive: true, force: true });
await rm(deployment, { recursive: true, force: true });
await mkdir(artifactsRoot, { recursive: true });
execFileSync('pnpm', ['deploy', '--filter', sourcePackage.name, '--prod', '--legacy', deployment], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
// pnpm deploy may include source/build inputs. Move only the resolved production
// dependency graph, then emit into fresh staging. Copying local dist would
// retain removed modules and stale casing after protocol migrations.
await mkdir(staging, { recursive: true });
await rename(join(deployment, 'node_modules'), join(staging, 'node_modules'));
await rm(deployment, { recursive: true, force: true });
execFileSync(process.execPath, ['scripts/build.mjs', '--outDir', join(staging, 'dist')], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
await writeFile(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: sourcePackage.name,
      version: sourcePackage.version,
      private: true,
      type: sourcePackage.type,
      engines: sourcePackage.engines,
      bin: sourcePackage.bin,
      exports: sourcePackage.exports,
      dependencies: sourcePackage.dependencies,
    },
    null,
    2,
  )}\n`,
);

const nativeDirectory = join(staging, 'native', `${process.platform}-${process.arch}`);
await mkdir(nativeDirectory, { recursive: true });
for (const name of [
  process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
  process.platform === 'win32' ? 'glyph-shell-sandbox.exe' : 'glyph-shell-sandbox',
]) {
  await cp(join(repositoryRoot, 'target', 'release', name), join(nativeDirectory, name));
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' }).trim() !== '';
const files = await checksums(staging);
await writeFile(
  join(staging, 'glyph-artifact.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      glyphCommit: commit,
      dirty,
      desktopProtocolVersion: codeOssPin.protocolVersion,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      files,
    },
    null,
    2,
  )}\n`,
);

await rm(archive, { force: true });
execFileSync('tar', ['-czf', archive, '-C', artifactsRoot, basename(staging)], { stdio: 'inherit' });
const archiveHash = await sha256(archive);
await writeFile(`${archive}.sha256`, `${archiveHash}  ${basename(archive)}\n`);
process.stdout.write(`${archive}\nsha256 ${archiveHash}\n`);

async function checksums(directory) {
  // The manifest covers every staged byte before the archive itself is created.
  const entries = [];
  await visit(directory);
  return entries.sort((left, right) => left.path.localeCompare(right.path));

  async function visit(current) {
    for (const name of await readdir(current)) {
      const path = join(current, name);
      const info = await stat(path);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile())
        entries.push({ path: relative(directory, path), sha256: await sha256(path), bytes: info.size });
    }
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
