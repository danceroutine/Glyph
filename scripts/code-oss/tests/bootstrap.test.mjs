import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const generatedRoot = join(repositoryRoot, '.code-oss');
const sourceRoot = join(generatedRoot, 'src');
const marker = join(sourceRoot, '.glyph-upstream.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function runScript({ files = () => ({}), download, statError } = {}) {
  const pin = { tag: '1.2.3', commit: 'pinned', archiveSha256: sha256('verified archive') };
  const archive = join(generatedRoot, `vscode-${pin.tag}.tar.gz`);
  const contents = { [join(repositoryRoot, 'code-oss', 'upstream.json')]: JSON.stringify(pin), ...files(archive, pin) };
  const operations = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const filesystem = {
    readFile: vi.fn(async (path, encoding) => {
      if (!(path in contents)) throw missing();
      return encoding ? contents[path] : Buffer.from(contents[path]);
    }),
    stat: vi.fn(async path => {
      if (statError) throw statError;
      if (!(path in contents)) throw missing();
      return {};
    }),
    writeFile: vi.fn(async (path, data) => {
      operations.push(['writeFile', path, typeof data === 'string' ? data : data.toString()]);
      contents[path] = data.toString();
    }),
    mkdir: vi.fn(async (...arguments_) => operations.push(['mkdir', ...arguments_])),
    rm: vi.fn(async (...arguments_) => operations.push(['rm', ...arguments_])),
  };
  const childProcess = {
    execFileSync: vi.fn((command, arguments_, options) => operations.push(['exec', command, arguments_, options])),
  };
  const fetch = vi.fn(async () => download ?? { ok: true, arrayBuffer: async () => Buffer.from('verified archive') });
  vi.stubGlobal('fetch', fetch);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    vi.unstubAllGlobals();
    stdout.mockRestore();
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:child_process');
  });
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('node:child_process', () => childProcess);
  const loaded = import('#scripts/code-oss/bootstrap.mjs');
  return { loaded, operations, fetch, stdout, archive, pin };
}

const applyOverlay = () => [
  'exec',
  process.execPath,
  [join(repositoryRoot, 'scripts', 'code-oss', 'apply-overlay.mjs')],
  { cwd: repositoryRoot, stdio: 'inherit' },
];

describe('bootstrap', () => {
  it('reapplies the overlay to an existing checkout of the pinned revision', async () => {
    const run = await runScript({ files: (_, pin) => ({ [marker]: JSON.stringify(pin) }) });
    await run.loaded;

    expect(run.fetch).not.toHaveBeenCalled();
    expect(run.operations).toEqual([['mkdir', generatedRoot, { recursive: true }], applyOverlay()]);
    expect(run.stdout).toHaveBeenCalledWith(`Code OSS 1.2.3 (pinned) is ready at ${sourceRoot}\n`);
  });

  it('refuses to mix an existing checkout of another revision', async () => {
    const run = await runScript({ files: () => ({ [marker]: JSON.stringify({ commit: 'other' }) }) });

    await expect(run.loaded).rejects.toThrow(
      'The generated Code OSS tree uses another revision. Remove .code-oss and retry.',
    );
  });

  it('extracts a cached verified archive without downloading it again', async () => {
    const run = await runScript({ files: archive => ({ [archive]: 'verified archive' }) });
    await run.loaded;

    expect(run.fetch).not.toHaveBeenCalled();
    expect(run.operations).toEqual([
      ['mkdir', generatedRoot, { recursive: true }],
      ['rm', sourceRoot, { recursive: true, force: true }],
      ['mkdir', sourceRoot, { recursive: true }],
      ['exec', 'tar', ['-xzf', run.archive, '--strip-components=1', '-C', sourceRoot], { stdio: 'inherit' }],
      ['writeFile', marker, `${JSON.stringify(run.pin, null, 2)}\n`],
      applyOverlay(),
    ]);
  });

  it.each([
    ['missing', () => ({})],
    ['corrupt', archive => ({ [archive]: 'corrupt archive' })],
  ])('downloads the pinned archive when the cache is %s', async (_, files) => {
    const run = await runScript({ files });
    await run.loaded;

    expect(run.fetch).toHaveBeenCalledWith('https://api.github.com/repos/microsoft/vscode/tarball/1.2.3', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'glyph-code-oss-bootstrap' },
      redirect: 'follow',
    });
    expect(run.operations.slice(1, 3)).toEqual([
      ['writeFile', run.archive, 'verified archive'],
      ['rm', sourceRoot, { recursive: true, force: true }],
    ]);
  });

  it('reports a failed download', async () => {
    const run = await runScript({ download: { ok: false, status: 404, statusText: 'Not Found' } });

    await expect(run.loaded).rejects.toThrow('Could not download Code OSS 1.2.3: 404 Not Found');
  });

  it('rejects a downloaded archive whose checksum does not match the pin', async () => {
    const run = await runScript({ download: { ok: true, arrayBuffer: async () => Buffer.from('tampered') } });

    await expect(run.loaded).rejects.toThrow(`Code OSS archive checksum mismatch: ${sha256('tampered')}`);
  });

  it('propagates failures to inspect the generated checkout', async () => {
    const run = await runScript({ statError: Object.assign(new Error('denied'), { code: 'EACCES' }) });

    await expect(run.loaded).rejects.toThrow('denied');
  });
});
