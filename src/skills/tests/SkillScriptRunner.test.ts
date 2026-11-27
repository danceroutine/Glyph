import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, onTestFinished, vi } from 'vitest';
import { SkillScriptRunner } from '#src/skills/SkillScriptRunner.js';
import { SkillPackage } from '#src/skills/SkillPackage.js';
import { aSkillDescriptor, aSkillPackage } from './fixtures/aSkillDescriptor.ts';

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-skill-execution-')));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const roots = ['A', 'B'].map(id => ({
    id,
    label: id,
    directory: join(directory, id),
    workingDirectory: id,
    originIds: [id],
  }));
  await Promise.all(roots.map(root => mkdir(root.directory)));
  const skill = aSkillPackage(
    aSkillDescriptor({ origin: { id: 'B', label: 'B', scope: 'project', compatibility: 'glyph' } }),
    'Run task',
    { 'scripts/task.sh': Buffer.from('./helper'), helper: Buffer.from('#!/bin/sh\necho pinned') },
  );
  const signal = new AbortController().signal;
  return { directory, roots, skill, signal };
}

it('runs secondary-root packages in their owning root using private, immutable resources with executable helpers', async () => {
  const f = await fixture();
  const files = new Map(f.skill.packageFiles());
  files.set('helper', { ...files.get('helper')!, mode: 0o755 });
  const skill = new SkillPackage(f.skill.descriptor, f.skill.body, files);
  const staged: string[] = [];
  const execute = vi.fn<ShellSessionManager['executeProgram']>(async (_command, options) => {
    expect(options).toMatchObject({ workingDirectory: 'B', transient: true, background: false });
    const directory = options.readOnlyPaths![0]!;
    staged.push(directory);
    expect(f.roots.every(root => !directory.startsWith(root.directory + '/'))).toBe(true);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'helper'))).mode & 0o777).toBe(0o500);
    expect((await stat(join(directory, 'scripts/task.sh'))).mode & 0o777).toBe(0o400);
    expect(await readFile(join(directory, 'helper'), 'utf8')).toContain('echo pinned');
    return { terminalId: 'shell', status: 'completed' as const, exitCode: 3, output: 'x'.repeat(17000) };
  });
  const runner = new SkillScriptRunner({ executeProgram: execute }, f.roots, join(f.directory, 'private'));
  expect(runner.targets).toEqual([
    { id: 'A', label: 'A' },
    { id: 'B', label: 'B' },
  ]);
  const result = await runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal);
  expect(JSON.stringify(result).slice(0, 100)).toContain('"exitCode":3');
  expect(skill.resources()).toEqual([]);
  await expect(stat(staged[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'A')).rejects.toThrow('owning');
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'missing')).rejects.toThrow('owning');
  expect(execute).toHaveBeenCalledOnce();
});

it('requires an explicit root for multi-root user skills and rejects staging inside any workspace', async () => {
  const f = await fixture();
  const skill = new SkillPackage(
    { ...f.skill.descriptor, origin: { id: 'user', label: 'User', scope: 'user', compatibility: 'glyph' } },
    f.skill.body,
    f.skill.packageFiles(),
  );
  const execute = vi.fn(async () => ({
    terminalId: 'shell',
    status: 'completed' as const,
    exitCode: 0,
    output: 'done',
  }));
  const runner = new SkillScriptRunner({ executeProgram: execute }, f.roots, join(f.directory, 'private'));
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('explicit root');
  await runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B');
  const single = new SkillScriptRunner({ executeProgram: execute }, [f.roots[0]!], join(f.directory, 'private'));
  await single.run(skill, 'scripts/task.sh', [], 'chat', f.signal);
  const unsafe = new SkillScriptRunner({ executeProgram: execute }, f.roots, join(f.roots[1]!.directory, 'staged'));
  await expect(unsafe.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B')).rejects.toThrow('outside every');
  const same = new SkillScriptRunner({ executeProgram: execute }, f.roots, f.roots[1]!.directory);
  await expect(same.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B')).rejects.toThrow('outside every');
  expect(execute).toHaveBeenCalledTimes(2);
});

it('cleans failed staging and does not record a disclosure when approval is denied', async () => {
  const f = await fixture();
  const staged: string[] = [];
  const execute = vi.fn<ShellSessionManager['executeProgram']>(async (_command, options) => {
    staged.push(options.readOnlyPaths![0]!);
    throw new Error('Denied');
  });
  const runner = new SkillScriptRunner({ executeProgram: execute }, f.roots, join(f.directory, 'private'));
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('Denied');
  expect(f.skill.resources()).toEqual([]);
  await expect(stat(staged[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', controller.signal)).rejects.toThrow('Cancelled');
});
