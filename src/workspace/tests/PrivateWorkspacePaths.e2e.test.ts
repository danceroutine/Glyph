import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileSystemWorkspaceTextStore } from '../FileSystemWorkspaceTextStore.ts';
import { WorkspaceAccessPolicy } from '../policy/WorkspaceAccessPolicy.ts';

it('keeps host state and transaction files private across containing, overlapping and directly attached roots', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'private-workspace-')));
  const project = join(base, 'work');
  const profile = join(project, 'Profile');
  const stagedRoot = join(profile, '.Skill-Staging', 'transaction');
  const privateFile = join(profile, 'skill-state.json');
  const publicPath = 'src/skill-state.json';
  const privateName = 'journal.json';
  const privateContent = 'host transaction data';
  const binaryPath = resolve(
    'target',
    'release',
    process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
  );
  onTestFinished(() => rm(base, { force: true, recursive: true }));
  for (const [path, content] of [
    [privateFile, privateContent],
    [join(project, publicPath), 'project data'],
    [join(stagedRoot, privateName), privateContent],
    [join(project, 'temporary/.skill-staging'), 'ordinary file with reserved name'],
  ] as const) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const policy = new WorkspaceAccessPolicy({ ignoredDirectories: [] }, [privateFile]);
  for (const [root, blocked, expected] of [
    [
      project,
      ['Profile/skill-state.json', 'Profile/.Skill-Staging/transaction/journal.json', 'temporary/.skill-staging'],
      [publicPath],
    ],
    [profile, ['SKILL-STATE.JSON', '.Skill-Staging/transaction/journal.json'], []],
    [stagedRoot, [privateName, 'future.md'], []],
  ] as const) {
    const store = new FileSystemWorkspaceTextStore(root, { caseSensitive: false, accessPolicy: policy });
    const index = new RustWorkspacePathIndex({ root, binaryPath, caseSensitive: false, accessPolicy: policy });
    try {
      await expect(store.list(20)).resolves.toEqual({ files: expected, truncated: false });
      await expect(index.glob('**/*', { limit: 20 })).resolves.toEqual({ files: expected, truncated: false });
      await expect(index.filterPaths([...blocked, ...expected])).resolves.toEqual(expected);
      await expect(
        index.searchContents(privateContent, {
          outputMode: 'files_with_matches',
          patternKind: 'literal',
          caseSensitive: true,
          linesBefore: 0,
          linesAfter: 0,
          multiline: false,
          limit: 20,
          offset: 0,
        }),
      ).resolves.toMatchObject({ files: [] });
      for (const target of blocked) {
        await expect(store.read(target)).rejects.toThrow('excluded');
        await expect(store.canonicalPath(target)).rejects.toThrow('excluded');
        await expect(store.create(target, 'unauthorized', false)).rejects.toThrow('excluded');
      }
      await expect(index.refresh()).resolves.toMatchObject({ fileCount: expected.length });
    } finally {
      await index.dispose();
    }
  }
});
