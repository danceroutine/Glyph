import type { ExecFileOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillPackageSourceReader } from '#src/skills/SkillPackageSource.js';

const git = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args: readonly string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
    ) => void
  >(),
);
vi.mock('node:child_process', () => ({ execFile: git }));
afterEach(() => git.mockReset());
const manifest = Buffer.from('---\nname: example\ndescription: Fixture\n---\nReviewed workflow');
const source = {
  kind: 'repository' as const,
  url: 'https://skills.invalid/example.git',
  revision: 'release',
  directory: '',
};
const reader = new SkillPackageSourceReader('unused');

function repository(entries = '100644 blob abc\tSKILL.md\0', blob = manifest) {
  git.mockImplementation((_command, args, _options, callback) => {
    const result = args.includes('rev-parse') ? 'deadbeef\n' : args.includes('ls-tree') ? entries : undefined;
    callback(null, args.includes('cat-file') ? blob : Buffer.from(result ?? ''), Buffer.alloc(0));
  });
}
describe('Repository package source boundary', () => {
  it('pins a root package to the resolved commit and bounds every Git subprocess', async () => {
    repository();
    const signal = new AbortController().signal;
    const draft = await reader.read(source, signal);
    expect(draft.name).toBe('example');
    expect(draft.source).toBe(`${source.url}@deadbeef`);
    expect(draft.files().get('SKILL.md')).toEqual(Uint8Array.from(manifest));
    expect(
      git.mock.calls.every(
        ([command, , options]) => command === 'git' && options.signal === signal && options.timeout === 60000,
      ),
    ).toBe(true);
    expect(git.mock.calls[0]?.[1]).toContain('core.hooksPath=/dev/null');
    expect(git.mock.calls[1]?.[1]).toContain('--end-of-options');
    expect(git.mock.calls[2]?.[1]).toContain('deadbeef');
  });
  it('uses the selected package subtree without checking out or running the package', async () => {
    repository();
    const draft = await reader.read({ ...source, directory: 'nested/example/' });
    expect(draft.name).toBe('example');
    expect(draft.source).toContain(':nested/example/');
    expect(git.mock.calls[2]?.[1]).toContain('deadbeef:nested/example');
    expect(git.mock.calls.flatMap(call => call[1])).not.toContain('checkout');
  });
  it('preserves subprocess failures without returning a partial package', async () => {
    git.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error('Authentication required'), Buffer.alloc(0), Buffer.alloc(0));
    });
    await expect(reader.read(source)).rejects.toThrow('Authentication required');
  });
  it.each([
    'https://token@skills.invalid/example.git',
    'https://skills.invalid/example.git?token=secret',
    'https://skills.invalid/example.git#secret',
  ])('rejects credential-bearing provenance before fetching %s', async url => {
    await expect(reader.read({ ...source, url })).rejects.toThrow('without embedded credentials');
    expect(git).not.toHaveBeenCalled();
  });
  it.each(['../outside', '/absolute', 'bad\\directory', 'bad:tree'])(
    'rejects unsafe package directories before fetching %s',
    async directory => {
      await expect(reader.read({ ...source, directory })).rejects.toThrow('relative');
      expect(git).not.toHaveBeenCalled();
    },
  );
  it('rejects symlink and submodule tree entries', async () => {
    for (const entry of ['120000 blob abc\tlink\0', '160000 commit abc\tmodule\0']) {
      repository(entry);
      await expect(reader.read(source)).rejects.toThrow('symlinks or submodules');
    }
  });
  it('bounds file count and total resource bytes before constructing a draft', async () => {
    repository(Array.from({ length: 257 }, (_, i) => `100644 blob abc\tfile-${i}\0`).join(''));
    await expect(reader.read(source)).rejects.toThrow('256 files');
    repository(Array.from({ length: 9 }, (_, i) => `100644 blob abc\tfile-${i}\0`).join(''), Buffer.alloc(1024 * 1024));
    await expect(reader.read(source)).rejects.toThrow('8 MiB');
  });
});
