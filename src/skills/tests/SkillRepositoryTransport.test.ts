import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SkillRepositoryGit } from '#src/skills/SkillRepositoryGit.js';

const io = vi.hoisted(() => ({
  list: vi.fn<(directory: string) => Promise<{ name: string; isDirectory: () => boolean }[]>>(),
  stat: vi.fn<(path: string) => Promise<{ size: number }>>(),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readdir: io.list, lstat: io.stat }));
vi.mock('#src/shell/TrustedHostExecutable.js', () => ({
  trustedHostExecutable: (name: string) => '/usr/bin/' + name,
  repositoryEnvironment: () => ({}),
}));
vi.mock('#src/skills/SkillRepositoryConfiguration.js', () => ({
  captureRepositoryEnvironment: async () => ({}),
}));
vi.mock('node:child_process', () => ({ spawn: io.spawn }));
function child(pid?: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  io.list.mockReset().mockResolvedValue([]);
  io.stat.mockReset().mockResolvedValue({ size: 0 });
  io.spawn.mockReset();
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const git = (signal = new AbortController().signal) =>
  new SkillRepositoryGit('/temporary', signal, [], testFilesystemMetadata);
it.each(['linux', 'win32'])('initializes a bare store without external Git configuration on %s', async os => {
  Object.defineProperty(process, 'platform', { ...platform, value: os });
  io.spawn.mockImplementation(() => {
    const initialized = child(123);
    queueMicrotask(() => {
      initialized.emit('close', 0);
    });
    return initialized;
  });
  await git().initialize('https://example.invalid/resource');
  expect(io.spawn).toHaveBeenCalledTimes(2);
  const options = expect.objectContaining({
    env: expect.objectContaining({
      GIT_CONFIG_GLOBAL: os === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }),
  });
  for (const call of io.spawn.mock.calls) expect(call[2]).toEqual(options);
});
it('counts directories and disappearing loose objects against the shared storage budget', async () => {
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
  io.list
    .mockResolvedValueOnce([
      { name: 'objects', isDirectory: () => true },
      { name: 'pack', isDirectory: () => false },
    ])
    .mockRejectedValueOnce(missing);
  io.stat.mockRejectedValueOnce(missing);
  const gitChild = child(123);
  io.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      gitChild.stdout.write('commit');
      gitChild.emit('close', 0);
    });
    return gitChild;
  });
  expect(await git().run(['fetch'])).toEqual(Buffer.from('commit'));
  io.list.mockRejectedValueOnce(new Error('root denied'));
  await expect(git().run(['fetch'])).rejects.toThrow('root denied');
  io.list.mockResolvedValueOnce([{ name: 'pack', isDirectory: () => false }]);
  io.stat.mockRejectedValueOnce(new Error('unreadable metadata'));
  await expect(git().run(['fetch'])).rejects.toThrow('unreadable metadata');
  io.list.mockResolvedValueOnce(
    Array.from({ length: 4097 }, (_, i) => ({ name: String(i), isDirectory: () => false })),
  );
  await expect(git().run(['fetch'])).rejects.toThrow('object-store budget');
});
it('stops an active transport when the periodically sampled object store grows past budget', async () => {
  vi.useFakeTimers();
  const gitChild = child(123);
  io.spawn.mockReturnValue(gitChild);
  const result = git().run(['fetch']);
  const rejected = expect(result).rejects.toThrow('32 MiB');
  await vi.advanceTimersByTimeAsync(55);
  io.list.mockResolvedValue([{ name: 'pack', isDirectory: () => false }]);
  io.stat.mockResolvedValue({ size: 33 * 1024 * 1024 });
  await vi.advanceTimersByTimeAsync(55);
  expect(process.kill).toHaveBeenCalledWith(-123, 'SIGKILL');
  gitChild.emit('close', 1);
  await rejected;
});
it('propagates failed launches, empty diagnostics, and cancellation while the process is being attached', async () => {
  const controller = new AbortController();
  const failed = child();
  io.spawn.mockImplementationOnce(() => {
    controller.abort('cancelled');
    queueMicrotask(() => {
      failed.emit('error', new Error('process missing'));
      failed.stderr.write(Buffer.alloc(65537));
      failed.emit('close', 1);
    });
    return failed;
  });
  await expect(git(controller.signal).run(['fetch'])).rejects.toThrow('cancelled');
  const next = child(123);
  io.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      next.emit('error', new Error('launch failed'));
      next.emit('close', 1);
    });
    return next;
  });
  await expect(git().run(['fetch'])).rejects.toThrow('launch failed');
  const silent = child(123);
  io.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      silent.emit('close', 1);
    });
    return silent;
  });
  await expect(git().run(['fetch'])).rejects.toThrow('Git repository access failed');
});
it.each(['win32', 'linux'])('falls back to closing the direct child when group termination fails on %s', async os => {
  Object.defineProperty(process, 'platform', { ...platform, value: os });
  const active = child(123),
    killer = child(456);
  io.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      active.stderr.write(Buffer.alloc(65537));
      active.emit('close', 1);
    });
    return active;
  });
  if (os === 'win32')
    io.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        killer.emit('error', new Error('taskkill unavailable'));
      });
      return killer;
    });
  else
    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw new Error('group exited');
    });
  await expect(git().run(['fetch'])).rejects.toThrow('diagnostics exceed');
  expect(active.kill).toHaveBeenCalledWith('SIGKILL');
});
