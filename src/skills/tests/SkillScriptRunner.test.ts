import { testPackageMutations } from './fixtures/testPackageMutations.ts';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import { Deferred } from '#src/shared/Deferred.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, onTestFinished, vi } from 'vitest';
import { SkillScriptRunner } from '#src/skills/SkillScriptRunner.js';
import { SkillPackage } from '#src/skills/SkillPackage.js';
import { aSkillDescriptor, aSkillPackage } from './fixtures/aSkillDescriptor.ts';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';

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
    { 'scripts/task.sh': Buffer.from('\uFEFF./helper'), helper: Buffer.from('#!/bin/sh\necho pinned') },
  );
  const signal = new AbortController().signal;
  return { directory, roots, skill, signal };
}

it('runs secondary-root packages in their owning root using private, immutable resources with executable helpers', async () => {
  const f = await fixture();
  const files = new Map(f.skill.packageFiles());
  files.set('helper', { ...files.get('helper')!, mode: 0o755 });
  const skill = new SkillPackage(f.skill.descriptor, f.skill.body, files, new Map([['templates/empty', 0o750]]));
  const staged: string[] = [];
  const execute = vi.fn<ShellSessionManager['executeProgram']>(async (command, options) => {
    expect(command.display).toContain('# \\uFEFF./helper');
    expect(options).toMatchObject({ workingDirectory: 'B', transient: true, background: false });
    const directory = options.readOnlyPaths![0]!;
    staged.push(directory);
    expect((await stat(join(directory, 'templates/empty'))).isDirectory()).toBe(true);
    expect((await stat(join(directory, 'templates/empty'))).mode & 0o777).toBe(0o750);
    expect(f.roots.every(root => !directory.startsWith(root.directory + '/'))).toBe(true);
    expect(await readFile(join(directory, 'scripts/task.sh'), 'utf8')).toBe('\uFEFF./helper');
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'helper'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(directory, 'scripts/task.sh'))).mode & 0o777).toBe(files.get('scripts/task.sh')!.mode);
    expect(await readFile(join(directory, 'helper'), 'utf8')).toContain('echo pinned');
    return { terminalId: 'shell', status: 'completed' as const, exitCode: 3, output: 'x'.repeat(17000) };
  });
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
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
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('explicit root');
  await rm(f.roots[0]!.directory, { recursive: true });
  await runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B');
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'A')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await mkdir(f.roots[0]!.directory);
  const single = new SkillScriptRunner(
    { executeProgram: execute },
    [f.roots[0]!],
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
  await single.run(skill, 'scripts/task.sh', [], 'chat', f.signal);
  const unsafe = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.roots[1]!.directory, 'staged'),
  );
  await expect(unsafe.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B')).rejects.toThrow(
    'outside writable workspaces',
  );
  const same = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    f.roots[1]!.directory,
  );
  await expect(same.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B')).rejects.toThrow(
    'outside writable workspaces',
  );
  expect(execute).toHaveBeenCalledTimes(2);
});

it('cleans failed staging and does not record a disclosure when approval is denied', async () => {
  const f = await fixture();
  const staged: string[] = [];
  const execute = vi.fn<ShellSessionManager['executeProgram']>(async (_command, options) => {
    staged.push(options.readOnlyPaths![0]!);
    throw new Error('Denied');
  });
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('Denied');
  expect(f.skill.resources()).toEqual([]);
  await expect(stat(staged[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  const controller = new AbortController();
  controller.abort(new Error('Cancelled'));
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', controller.signal)).rejects.toThrow('Cancelled');
});

it('rejects inherited access controls before exposing a pinned file or requesting approval', async () => {
  const f = await fixture();
  const execute = vi.fn();
  const metadata = {
    ...testFilesystemMetadata,
    inspect: vi.fn<FilesystemMetadata['inspect']>(async () => {
      throw new Error('Inherited ACL');
    }),
  };
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    metadata,
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('Inherited ACL');
  expect(execute).not.toHaveBeenCalled();
  const handle = metadata.inspect.mock.calls[0]![0];
  expect(handle.fd).toBe(-1);
});

it('closes a rejected script inode and cleans a scaffold whose reviewed directories are not writable', async () => {
  const f = await fixture();
  const execute = vi.fn<ShellSessionManager['executeProgram']>(async (_program, options) => {
    expect((await stat(join(options.readOnlyPaths![0]!, 'locked'))).mode & 0o777).toBe(0);
    // Explicit full-access execution can remove its own staging resources.
    await chmod(join(options.readOnlyPaths![0]!, 'locked'), 0o700);
    await rm(join(options.readOnlyPaths![0]!, 'locked/empty'), { recursive: true });
    return { terminalId: 'shell', status: 'completed', exitCode: 0, output: '' };
  });
  const skill = new SkillPackage(
    f.skill.descriptor,
    f.skill.body,
    f.skill.packageFiles(),
    new Map([
      ['locked', 0],
      ['locked/empty', 0o500],
    ]),
  );
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
  await runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal);
  const inspect = vi.fn<FilesystemMetadata['inspect']>(async handle => {
    if ((await handle.stat()).isFile()) throw new Error('File ACL');
  });
  const rejected = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    { ...testFilesystemMetadata, inspect },
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
  );
  await expect(rejected.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('File ACL');
  expect(execute).toHaveBeenCalledOnce();
  expect(inspect.mock.calls.at(-1)![0].fd).toBe(-1);
});

it('rechecks peer-window roots and native physical aliases before approval and after authority changes', async () => {
  const f = await fixture();
  let peers = f.roots.map(root => root.directory);
  const validate = vi.fn(testFilesystemMetadata.assertHostPaths);
  const execute = vi.fn<ShellSessionManager['executeProgram']>(async program => {
    await program.assertAuthority();
    peers = [...peers, (await import('node:path')).dirname(program.executable)];
    await program.assertAuthority();
    throw new Error('Process must not launch');
  });
  const runner = new SkillScriptRunner(
    { executeProgram: execute },
    f.roots,
    { ...testFilesystemMetadata, assertHostPaths: validate },
    async root => testPackageMutations(root),
    join(f.directory, 'private'),
    () => peers,
  );
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow(
    'outside writable workspaces',
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(validate).toHaveBeenCalledTimes(3);
  peers = f.roots.map(root => root.directory);
  validate.mockRejectedValueOnce(new Error('Bound interpreter alias'));
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow('Bound interpreter alias');
  expect(execute).toHaveBeenCalledOnce();
  peers.push(join(f.directory, 'private'));
  await expect(runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal)).rejects.toThrow(
    'outside writable workspaces',
  );
});

it('stops a reviewed script before launch when the native interpreter authority is revoked during approval', async () => {
  const f = await fixture();
  const pendingReview = new Deferred<void>();
  const decision = new Deferred<{ sandboxProfile: ShellSandboxProfile }>();
  const authorize = vi.fn(async () => {
    pendingReview.resolve();
    return decision.promise;
  });
  const launch = vi.fn(() => {
    throw new Error('Unexpected process creation');
  });
  const shells = new ShellSessionManager({ authorize } as never, { resolve: async () => f.directory } as never, {
    launch,
  });
  onTestFinished(() => shells.dispose());
  const interpreter = await realpath('/bin/sh');
  let nativeAdmits = true;
  const assertHostPaths = vi.fn(async (paths: readonly string[], _roots: readonly string[]) => {
    if (!nativeAdmits && paths.includes(interpreter)) throw new Error('Native interpreter authority changed');
  });
  const staging = join(f.directory, 'staging');
  const runner = new SkillScriptRunner(
    shells,
    f.roots,
    { ...testFilesystemMetadata, assertHostPaths },
    async root => testPackageMutations(root),
    staging,
  );
  const running = runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal);
  await pendingReview.promise;
  const before = assertHostPaths.mock.calls.length;
  nativeAdmits = false;
  decision.resolve({ sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE });
  await expect(running).rejects.toThrow('Native interpreter authority changed');
  expect(assertHostPaths).toHaveBeenCalledTimes(before + 1);
  expect(assertHostPaths.mock.lastCall).toEqual([
    expect.arrayContaining([interpreter, expect.stringContaining(staging + '/glyph-skill-run-')]),
    f.roots.map(root => root.directory),
  ]);
  expect(launch).not.toHaveBeenCalled();
  expect(shells.sessions).toEqual([]);
});

it.each(['helper', 'turn'] as const)('withholds an approved process after its %s becomes unavailable', async reason => {
  const f = await fixture();
  const files = new Map(f.skill.packageFiles());
  const origin = { path: '/source/helper', identity: '7:9', origin: 'selected route' };
  files.set('helper', { ...files.get('helper')!, identity: origin.identity });
  let approved = false;
  const checkSource = vi.fn(() => {
    if (approved && reason === 'helper') throw new Error('Helper is private');
  });
  const authority = { capture: vi.fn(), authorize: vi.fn(async () => checkSource) };
  const skill = new SkillPackage(
    f.skill.descriptor,
    f.skill.body,
    files,
    undefined,
    new Map([['helper', { authority, file: origin }]]),
  );
  const authorize = vi.fn(async () => {
    approved = true;
    return { sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE };
  });
  const launch = vi.fn(() => {
    throw new Error('Unexpected launch');
  });
  const shells = new ShellSessionManager({ authorize } as never, { resolve: async () => f.directory } as never, {
    launch,
  });
  onTestFinished(() => shells.dispose());
  const runner = new SkillScriptRunner(
    shells,
    f.roots,
    testFilesystemMetadata,
    async root => testPackageMutations(root),
    join(f.directory, 'staging'),
  );
  const checkTurn = () => {
    if (approved && reason === 'turn') throw new Error('Turn ended');
  };
  await expect(runner.run(skill, 'scripts/task.sh', [], 'chat', f.signal, 'B', checkTurn)).rejects.toThrow(
    reason === 'helper' ? 'Helper is private' : 'Turn ended',
  );
  expect(authorize).toHaveBeenCalledOnce();
  expect(authority.authorize).toHaveBeenCalledWith([origin], f.signal);
  expect(launch).not.toHaveBeenCalled();
});

it.each(['staging', 'execution'] as const)(
  'holds an overlapping peer through %s cancellation and private cleanup',
  async phase => {
    const f = await fixture();
    const staging = join(f.directory, 'staging');
    const leases = new HostProcessLeases(f.roots.map(root => root.directory));
    const started = new Deferred<void>();
    const resume = new Deferred<void>();
    const cleaning = new Deferred<void>();
    const cleanupStarted = vi.fn();
    const remove = new Deferred<void>();
    const child = Object.assign(new ChildProcess(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const launch = vi.fn(() => {
      started.resolve();
      return child;
    });
    const shells = new ShellSessionManager(
      { authorize: async () => ({ sandboxProfile: ShellSandboxProfile.READ_ONLY }) } as never,
      { resolve: async () => f.roots[1]!.directory } as never,
      { launch },
    );
    onTestFinished(() => shells.dispose());
    const runner = new SkillScriptRunner(
      shells,
      f.roots,
      {
        ...testFilesystemMetadata,
        inspect: async handle => {
          if (phase === 'staging' && (await handle.stat()).isFile()) {
            started.resolve();
            await resume.promise;
          }
        },
      },
      async root => ({
        removeTree: async relative => {
          cleanupStarted();
          cleaning.resolve();
          await remove.promise;
          await testPackageMutations(root).removeTree(relative);
        },
      }),
      staging,
      leases,
    );
    const run = runner.run(f.skill, 'scripts/task.sh', [], 'chat', f.signal);
    const rejected = expect(run).rejects.toThrow('workspace is attaching');
    await started.promise;
    const disjoint = vi.fn();
    await leases.admitWorkspace(() => [join(f.directory, 'disjoint')], disjoint);
    expect(disjoint).toHaveBeenCalledOnce();
    const publish = vi.fn();
    const admission = leases.admitWorkspace(() => [staging], publish);
    // Dispose may race process cancellation when a window disconnects.
    const disposed = phase === 'execution' ? shells.dispose() : undefined;
    await setImmediate();
    expect(publish).not.toHaveBeenCalled();
    if (phase === 'execution') {
      expect(launch).toHaveBeenCalledOnce();
      expect(cleanupStarted).not.toHaveBeenCalled();
      child.emit('close', 0, null);
    } else {
      resume.resolve();
      expect(launch).not.toHaveBeenCalled();
    }
    await cleaning.promise;
    expect(publish).not.toHaveBeenCalled();
    remove.resolve();
    await Promise.all([rejected, admission, disposed]);
    expect(publish).toHaveBeenCalledOnce();
  },
);
