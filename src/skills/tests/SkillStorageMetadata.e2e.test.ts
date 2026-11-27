import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { SkillPackageSourceReader } from '#src/skills/SkillPackageSource.js';
import { SkillScriptRunner } from '#src/skills/SkillScriptRunner.js';
import { aSkillPackage } from './fixtures/aSkillDescriptor.ts';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';
import { SkillTransactionJournal } from '#src/skills/SkillTransactionJournal.js';
import { privateSkillDirectory } from '#src/skills/SkillPackageStorage.js';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

const metadata = new NativeFilesystemMetadata(resolve('target/release/glyph-context-index'));
const openMutations = (root: string) =>
  NativeWorkspaceMutations.open(resolve('target/release/glyph-workspace-mutations'), root);
const chmodAcl = (path: string, ...args: string[]) => execFileSync('/bin/chmod', [...args, path]);

it.skipIf(process.platform !== 'darwin')(
  'rejects a local source with secondary asset data before producing an approved draft',
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'glyph-import-metadata-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'example');
    await mkdir(root);
    await writeFile(join(root, 'SKILL.md'), '---\nname: example\ndescription: Example\n---\nInstructions');
    const asset = join(root, 'asset');
    await writeFile(asset, '');
    await writeFile(join(asset, '..namedfork/rsrc'), 'secondary bytes');
    const reader = new SkillPackageSourceReader(resolve('target/release/glyph-context-index'), [], metadata);
    await expect(reader.read({ kind: 'local', path: root })).rejects.toThrow('metadata');
    expect(await readFile(join(asset, '..namedfork/rsrc'), 'utf8')).toBe('secondary bytes');
  },
);

it.skipIf(process.platform !== 'darwin')(
  'checks inherited temporary ACLs before staging scripts or starting repository transport',
  async () => {
    const base = await mkdtemp(join(tmpdir(), 'glyph-run-inheritance-'));
    onTestFinished(() => rm(base, { recursive: true, force: true }));
    const workspace = join(base, 'workspace'),
      temporary = join(base, 'temporary');
    await mkdir(workspace);
    await mkdir(temporary);
    chmodAcl(temporary, '+a', 'everyone allow list,search,file_inherit,directory_inherit');
    const execute = vi.fn();
    const runner = new SkillScriptRunner(
      { executeProgram: execute },
      [{ id: 'project', label: 'Project', directory: workspace, workingDirectory: '.', originIds: ['project'] }],
      metadata,
      temporary,
    );
    const skill = aSkillPackage(undefined, undefined, { 'scripts/task.sh': Buffer.from('echo should-not-run') });
    try {
      await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', new AbortController().signal)).rejects.toThrow(
        'metadata',
      );
      expect(execute).not.toHaveBeenCalled();
      expect(await readdir(temporary)).toEqual([]);
      vi.stubEnv('TMPDIR', temporary);
      const reader = new SkillPackageSourceReader(resolve('target/release/glyph-context-index'), [workspace], metadata);
      await expect(
        reader.read({
          kind: 'repository',
          url: 'https://fixture.invalid/example.git',
          revision: 'main',
          directory: '',
        }),
      ).rejects.toThrow('metadata');
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      chmodAcl(temporary, '-N');
    }
  },
);

it.skipIf(process.platform !== 'darwin')(
  'rejects private directories with inherited access grants before writing a marker',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-private-inheritance-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    chmodAcl(root, '+a', 'everyone allow list,search,file_inherit,directory_inherit');
    const stage = join(root, '.skill-staging');
    try {
      await expect(privateSkillDirectory(metadata, root)).rejects.toThrow('metadata');
      expect((await stat(stage)).mode & 0o777).toBe(0o700);
      expect(execFileSync('/bin/ls', ['-lde', stage], { encoding: 'utf8' })).toContain('inherited');
      await expect(stat(join(stage, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      chmodAcl(root, '-N');
      chmodAcl(stage, '-N');
    }
  },
);

it.skipIf(process.platform !== 'darwin')(
  'keeps the original preference inode for every writer when its ACL cannot be reproduced',
  async () => {
    const { root, state, store } = await aSkillLifecycle(openMutations, metadata);
    await state.setEnabled('old', false);
    const path = join(root, 'skill-state.json');
    const inode = (await stat(path)).ino;
    const contents = await readFile(path);
    chmodAcl(path, '+a', 'everyone deny write');
    try {
      const operations = [
        () => state.setEnabled('old', true),
        () => state.record('old', 'fixture', '1'),
        () => state.forget('old'),
        () => state.migratePackageIds(new Map([['new', ['old']]])),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow('metadata');
        expect((await stat(path)).ino).toBe(inode);
        expect(await readFile(path)).toEqual(contents);
      }
    } finally {
      chmodAcl(path, '-N');
    }
    chmodAcl(store.root, '+a', 'everyone deny delete_child');
    try {
      await expect(state.setEnabled('old', true)).rejects.toThrow('metadata');
    } finally {
      chmodAcl(store.root, '-N');
    }
  },
);

it.skipIf(process.platform !== 'darwin')(
  'preserves resource forks on unchanged package assets before and after approval',
  async () => {
    const { root, manager, install } = await aSkillLifecycle(openMutations, metadata);
    const skill = await install();
    const prepare = () => manager.prepare(skill.origin.id, aSkillDraft('new instructions'), skill.id);
    const preview = await prepare();
    const asset = join(root, skill.directory, 'assets/image.bin');
    const fork = join(asset, '..namedfork/rsrc');
    await writeFile(fork, 'secondary stream');
    await expect(prepare()).rejects.toThrow('extended data');
    await expect(manager.apply(preview.id)).rejects.toThrow('extended data');
    expect(await readFile(fork, 'utf8')).toBe('secondary stream');
    expect(await readFile(join(root, skill.path), 'utf8')).toContain('Reviewed instructions');
  },
);

it.skipIf(process.platform !== 'darwin')(
  'checks existing database and rollback journal ACLs before using SQLite',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-journal-acl-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const staging = await privateSkillDirectory(metadata, root);
    const journal = new SkillTransactionJournal(root, metadata);
    const db = join(staging, 'journal.sqlite');
    await writeFile(db, '', { mode: 0o600 });
    for (const path of [db, db + '-journal']) {
      if (path !== db) await writeFile(path, '', { mode: 0o600 });
      chmodAcl(path, '+a', 'everyone allow read');
      try {
        await expect(journal.entries(root, 'scope')).rejects.toThrow('metadata');
      } finally {
        chmodAcl(path, '-N');
      }
    }
  },
);
