import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const artifactsRoot = join(repositoryRoot, '.artifacts');
const staging = join(artifactsRoot, 'glyph-desktop-host');
const deployment = join(artifactsRoot, '.glyph-desktop-host-deploy');
const archive = join(artifactsRoot, 'glyph-desktop-host.tgz');

const sha256 = text => createHash('sha256').update(text).digest('hex');

async function runScript({ status = '', platform } = {}) {
  const operations = [];
  const sourcePackage = {
    name: 'glyph',
    version: '1.2.3',
    type: 'module',
    engines: { node: '>=22' },
    bin: { glyph: './dist/cli.js' },
    exports: { './desktop-host': './dist/desktop/host/index.js' },
    dependencies: { zod: '^4.0.0' },
    devDependencies: { vitest: '^5.0.0' },
    scripts: { test: 'vitest' },
  };
  const tree = {
    [staging]: ['package.json', 'dist', 'socket'],
    [join(staging, 'dist')]: ['b.js', 'a.js'],
  };
  const files = {
    [join(staging, 'package.json')]: 'package',
    [join(staging, 'dist', 'a.js')]: 'alpha',
    [join(staging, 'dist', 'b.js')]: 'bravo!',
    [archive]: 'archive bytes',
  };
  const filesystem = {
    readFile: vi.fn(async (path, encoding) => {
      if (path === join(repositoryRoot, 'package.json')) return JSON.stringify(sourcePackage);
      if (path === join(repositoryRoot, 'code-oss', 'upstream.json')) return JSON.stringify({ protocolVersion: 9 });
      expect(encoding).toBeUndefined();
      return Buffer.from(files[path]);
    }),
    readdir: vi.fn(async path => tree[path]),
    stat: vi.fn(async path => ({
      isDirectory: () => path in tree,
      isFile: () => path in files,
      size: files[path]?.length ?? 0,
    })),
    rm: vi.fn(async (...arguments_) => operations.push(['rm', ...arguments_])),
    mkdir: vi.fn(async (...arguments_) => operations.push(['mkdir', ...arguments_])),
    rename: vi.fn(async (...arguments_) => operations.push(['rename', ...arguments_])),
    cp: vi.fn(async (...arguments_) => operations.push(['cp', ...arguments_])),
    writeFile: vi.fn(async (...arguments_) => operations.push(['writeFile', ...arguments_])),
  };
  const childProcess = {
    execFileSync: vi.fn((command, arguments_, options) => {
      operations.push(['exec', command, arguments_, options]);
      if (arguments_[0] === 'rev-parse') return 'abc123\n';
      if (arguments_[0] === 'status') return status;
      return undefined;
    }),
  };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platform) Object.defineProperty(process, 'platform', { value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', descriptor);
    stdout.mockRestore();
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:child_process');
  });
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('node:child_process', () => childProcess);
  await import('#scripts/build-desktop-artifact.mjs');
  return { operations, sourcePackage, stdout };
}

describe('build-desktop-artifact', () => {
  it('stages production dependencies, emitted host code, and native helpers before archiving them', async () => {
    const { operations, sourcePackage } = await runScript();
    const native = join(staging, 'native', `${process.platform}-${process.arch}`);

    expect(operations.map(([kind, ...rest]) => [kind, ...rest.slice(0, 2)])).toEqual([
      ['rm', staging, { recursive: true, force: true }],
      ['rm', deployment, { recursive: true, force: true }],
      ['mkdir', artifactsRoot, { recursive: true }],
      [
        'exec',
        'pnpm',
        ['deploy', '--filter', 'glyph', '--prod', '--legacy', '--config.allowUnusedPatches=true', deployment],
      ],
      ['mkdir', staging, { recursive: true }],
      ['rename', join(deployment, 'node_modules'), join(staging, 'node_modules')],
      ['rm', deployment, { recursive: true, force: true }],
      ['exec', process.execPath, ['scripts/build.mjs', '--outDir', join(staging, 'dist')]],
      ['writeFile', join(staging, 'package.json'), expect.any(String)],
      ['mkdir', native, { recursive: true }],
      ['cp', join(repositoryRoot, 'target', 'release', 'glyph-context-index'), join(native, 'glyph-context-index')],
      ['cp', join(repositoryRoot, 'target', 'release', 'glyph-shell-sandbox'), join(native, 'glyph-shell-sandbox')],
      ['exec', 'git', ['rev-parse', 'HEAD']],
      ['exec', 'git', ['status', '--porcelain']],
      ['writeFile', join(staging, 'glyph-artifact.json'), expect.any(String)],
      ['rm', archive, { force: true }],
      ['exec', 'tar', ['-czf', archive, '-C', artifactsRoot, 'glyph-desktop-host']],
      ['writeFile', `${archive}.sha256`, `${sha256('archive bytes')}  glyph-desktop-host.tgz\n`],
    ]);
    for (const [kind, command, , options] of operations.filter(([kind]) => kind === 'exec')) {
      if (command === 'git') expect(options).toEqual({ cwd: repositoryRoot, encoding: 'utf8' });
      else if (command === 'tar') expect(options).toEqual({ stdio: 'inherit' });
      else expect(options).toEqual({ cwd: repositoryRoot, stdio: 'inherit' });
      expect(kind).toBe('exec');
    }
    const packageJson = operations.find(([kind, path]) => kind === 'writeFile' && path.endsWith('package.json'))[2];
    expect(packageJson).toBe(
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
  });

  it('records the commit, clean state, protocol, platform, and sorted checksums of every staged file', async () => {
    const { operations } = await runScript();

    const manifest = operations.find(([kind, path]) => kind === 'writeFile' && path.endsWith('glyph-artifact.json'))[2];
    expect(manifest.endsWith('}\n')).toBe(true);
    expect(JSON.parse(manifest)).toEqual({
      schemaVersion: 1,
      glyphCommit: 'abc123',
      dirty: false,
      desktopProtocolVersion: 9,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      files: [
        { path: join('dist', 'a.js'), sha256: sha256('alpha'), bytes: 5 },
        { path: join('dist', 'b.js'), sha256: sha256('bravo!'), bytes: 6 },
        { path: 'package.json', sha256: sha256('package'), bytes: 7 },
      ],
    });
  });

  it('marks artifacts built from a modified checkout as dirty', async () => {
    const { operations } = await runScript({ status: ' M src/cli.ts\n' });

    const manifest = operations.find(([kind, path]) => kind === 'writeFile' && path.endsWith('glyph-artifact.json'))[2];
    expect(JSON.parse(manifest).dirty).toBe(true);
  });

  it('copies Windows executables on Windows', async () => {
    const { operations } = await runScript({ platform: 'win32' });

    expect(operations.filter(([kind]) => kind === 'cp').map(([, source]) => source)).toEqual([
      join(repositoryRoot, 'target', 'release', 'glyph-context-index.exe'),
      join(repositoryRoot, 'target', 'release', 'glyph-shell-sandbox.exe'),
    ]);
  });

  it('prints the archive path and checksum', async () => {
    const { stdout } = await runScript();

    expect(stdout).toHaveBeenCalledWith(`${archive}\nsha256 ${sha256('archive bytes')}\n`);
  });
});
