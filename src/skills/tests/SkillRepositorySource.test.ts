import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillPackageSourceReader } from '#src/skills/SkillPackageSource.js';

const git = vi.hoisted(() => vi.fn<(args: string[], maxOutput?: number) => Promise<Buffer>>());
vi.mock('#src/skills/SkillRepositoryGit.js', () => ({
  SkillRepositoryGit: class {
    initialize = vi.fn();
    run = git;
  },
}));
afterEach(() => git.mockReset());
const manifest = Buffer.from('---\nname: example\ndescription: Fixture\n---\nReviewed workflow');
const source = {
  kind: 'repository' as const,
  url: 'https://skills.invalid/example.git',
  revision: 'release',
  directory: '',
};
const reader = new SkillPackageSourceReader('unused', [], testFilesystemMetadata);

function repository(entries = '100644 blob abc\tSKILL.md\0', blob = manifest) {
  git.mockImplementation(async args => {
    const result = args.includes('rev-parse') ? 'deadbeef\n' : args.includes('ls-tree') ? entries : undefined;
    return args.includes('cat-file') ? blob : Buffer.from(result ?? '');
  });
}
describe('Repository package source boundary', () => {
  it('consults current host-wide roots when opening a repository preview', async () => {
    repository();
    const roots = vi.fn(() => []);
    const sourceReader = new SkillPackageSourceReader('unused', [], testFilesystemMetadata, roots);
    expect((await sourceReader.read(source)).name).toBe('example');
    expect(roots).toHaveBeenCalled();
  });
  it('derives the same root package name when the repository URL has trailing slashes', async () => {
    repository();
    expect((await reader.read({ ...source, url: source.url + '//' })).name).toBe('example');
  });
  it('rejects a tree pathname that cannot round-trip through UTF-8 before capturing any resource', async () => {
    repository();
    const run = git.getMockImplementation()!;
    git.mockImplementation(async (args, maxOutput) =>
      args.includes('ls-tree')
        ? Buffer.concat([Buffer.from('100644 blob abc\tasset-'), Buffer.from([0xff]), Buffer.from('\0')])
        : run(args, maxOutput),
    );
    await expect(reader.read(source)).rejects.toThrow('Repository paths must use valid UTF-8');
    expect(git.mock.calls.some(([args]) => args.includes('cat-file'))).toBe(false);
  });
  it('pins a root package to the resolved commit and bounds every Git subprocess', async () => {
    repository();
    const signal = new AbortController().signal;
    const draft = await reader.read(source, signal);
    expect(draft.name).toBe('example');
    expect(draft.source).toBe(`Requested repository ${source.url}@deadbeef`);
    expect(draft.files().get('SKILL.md')).toEqual(Uint8Array.from(manifest));
    expect(git.mock.calls.find(([args]) => args.includes('fetch'))?.[0]).toEqual(
      expect.arrayContaining(['--depth=1', '--no-tags', '--filter=blob:none', source.revision]),
    );
    expect(git.mock.calls.find(([args]) => args.includes('cat-file'))?.[1]).toBe(1024 * 1024);
  });
  it('uses the selected package subtree without checking out or running the package', async () => {
    repository();
    const draft = await reader.read({ ...source, directory: 'nested/example/' });
    expect(draft.name).toBe('example');
    expect(draft.source).toContain(':nested/example/');
    expect(git.mock.calls.find(([args]) => args.includes('ls-tree'))?.[0]).toContain('deadbeef:nested/example');
    expect(git.mock.calls.flatMap(call => call[0])).not.toContain('checkout');
  });
  it.each([
    ['.', 'deadbeef'],
    ['./', 'deadbeef'],
    ['./nested//example/.', 'deadbeef:nested/example'],
  ])('normalizes repository directory %s for the selected tree and package name', async (directory, tree) => {
    repository();
    expect((await reader.read({ ...source, directory })).name).toBe('example');
    expect(git.mock.calls.find(([args]) => args.includes('ls-tree'))?.[0].at(-1)).toBe(tree);
  });
  it('preserves subprocess failures without returning a partial package', async () => {
    git.mockRejectedValue(new Error('Authentication required'));
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
  it.each(['../outside', 'valid/../example', '/absolute', 'bad\\directory', 'bad:tree'])(
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

it('rejects unsafe revision expressions before spawning Git and preserves executable Git tree entries', async () => {
  for (const revision of ['--option', 'branch..other'])
    await expect(reader.read({ ...source, revision })).rejects.toThrow('commit, branch or tag');
  expect(git).not.toHaveBeenCalled();
  repository('100755 blob abc\tSKILL.md\0');
  expect((await reader.read(source)).packageFiles().get('SKILL.md')?.mode).toBe(0o755);
});

it('retains explicit Git trees without blobs and bounds the total tree entry count', async () => {
  repository('100644 blob abc\tSKILL.md\u0000040000 tree abc\ttemplates\0');
  expect((await reader.read(source)).packageDirectories()).toEqual(new Map([['templates', 0o755]]));
  repository('040000 tree abc\tdirectory\0'.repeat(8451));
  await expect(reader.read(source)).rejects.toThrow('directory budget');
});
