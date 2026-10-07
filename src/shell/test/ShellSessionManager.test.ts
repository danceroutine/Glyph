import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeShellSandboxLauncher } from '../NativeShellSandboxLauncher.ts';
import type { ShellCommandAuthorizer } from '../ShellCommandAuthorizer.ts';
import { ShellSandboxProfile } from '../ShellSandboxProfile.ts';
import { ShellSessionManager } from '../ShellSessionManager.ts';
import { ShellSessionStatus } from '../ShellSessionStatus.ts';
import type { ShellWorkingDirectoryResolver } from '../ShellWorkingDirectoryResolver.ts';

const managers: ShellSessionManager[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ShellSessionManager, () => {
  describe('command lifecycle', () => {
    it('executes an authorized foreground command and removes its transient terminal', async () => {
      const { manager, authorize } = await fixture();
      const changed = vi.fn();
      const stop = manager.onDidChange(changed);
      manager.setOwnerChat('chat-one');

      const result = await manager.execute('printf foreground', {
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({ status: 'completed', output: 'foreground', exitCode: 0 });
      expect(manager.sessions).toEqual([]);
      expect(authorize).toHaveBeenCalledWith('printf foreground', expect.any(String), expect.any(AbortSignal), {
        background: false,
        existingTerminal: false,
      });
      expect(changed).toHaveBeenCalled();
      stop();
    });

    it('backgrounds a terminal, wakes across output chunks, and reuses it for a subsequent command', async () => {
      const { manager } = await fixture();
      manager.setOwnerChat('chat-one');
      const wakes: unknown[] = [];
      const stopWake = manager.onDidWake(event => wakes.push(event));

      const background = await manager.execute('printf rea; sleep 0.02; printf dy', {
        background: true,
        wakeOn: 'ready',
        signal: new AbortController().signal,
      });
      await waitUntil(() => wakes.length === 1 && manager.sessions[0]?.status === ShellSessionStatus.IDLE);

      expect(manager.takePendingWake('missing')).toBeUndefined();
      expect(manager.takePendingWake()).toMatchObject({
        terminalId: background.terminalId,
        ownerChatId: 'chat-one',
        pattern: 'ready',
        output: expect.stringContaining('ready'),
      });
      expect(manager.sessions[0]?.wakePattern).toBeUndefined();

      const second = await manager.execute('printf second', {
        terminalId: background.terminalId,
        signal: new AbortController().signal,
      });

      expect(second).toMatchObject({ status: 'completed', output: 'second', exitCode: 0 });
      expect(manager.sessions[0]).toMatchObject({
        id: background.terminalId,
        background: true,
        status: ShellSessionStatus.IDLE,
        command: 'printf second',
      });
      stopWake();
      await manager.close(background.terminalId);
      expect(manager.sessions).toEqual([]);
    });

    it('writes interactive input only to a running command and can configure its wake condition', async () => {
      const { manager } = await fixture();
      const command = await manager.execute('read value; printf "got:%s" "$value"', {
        background: true,
        signal: new AbortController().signal,
      });

      manager.writeInput(command.terminalId, 'answer', true, 'got:answer');
      await waitUntil(
        () =>
          manager.sessions[0]?.status === ShellSessionStatus.IDLE &&
          manager.sessions[0]?.outputTail.includes('got:answer') === true,
      );

      expect(manager.takePendingWake()).toMatchObject({ pattern: 'got:answer' });
      expect(manager.sessions[0]?.outputTail).toContain('got:answer');
      expect(() => manager.writeInput(command.terminalId, 'next', true)).toThrow('only allowed while');
    });

    it('terminates a timed-out command while retaining its reusable terminal', async () => {
      const { manager } = await fixture();
      const terminal = await manager.execute('printf ready', {
        background: true,
        signal: new AbortController().signal,
      });
      await waitUntil(() => manager.sessions[0]?.status === ShellSessionStatus.IDLE);

      await expect(
        manager.execute('sleep 1', {
          terminalId: terminal.terminalId,
          timeoutMs: 5,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();

      expect(manager.sessions).toHaveLength(1);
      expect(manager.sessions[0]?.status).toBe(ShellSessionStatus.IDLE);
    });

    it('reports busy, unknown, timeout, cancellation, and disposed-session failures', async () => {
      const { manager } = await fixture();
      const background = await manager.execute('sleep 1', {
        background: true,
        signal: new AbortController().signal,
      });

      await expect(
        manager.execute('printf blocked', {
          terminalId: background.terminalId,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('busy');
      await expect(manager.close('missing')).rejects.toThrow('Unknown shell terminal');

      const timeout = manager.execute('sleep 1', {
        timeoutMs: 5,
        signal: new AbortController().signal,
      });
      await expect(timeout).rejects.toThrow();

      const cancellation = new AbortController();
      const cancelled = manager.execute('sleep 1', { signal: cancellation.signal });
      cancellation.abort(new Error('cancelled'));
      await expect(cancelled).rejects.toThrow('cancelled');

      manager.shutdown();
      await manager.dispose();
      await manager.dispose();
      await expect(manager.execute('printf closed', { signal: new AbortController().signal })).rejects.toThrow(
        'closed',
      );
    });

    it('does not launch after cancellation or disposal while authorization is pending', async () => {
      const { manager, authorize } = await fixture();
      const alreadyCancelled = new AbortController();
      alreadyCancelled.abort(new Error('already cancelled'));

      await expect(manager.execute('printf forbidden', { signal: alreadyCancelled.signal })).rejects.toThrow(
        'already cancelled',
      );
      expect(authorize).not.toHaveBeenCalled();

      const pendingAuthorization = deferredAuthorization();
      authorize.mockImplementationOnce(() => pendingAuthorization.promise);
      const pending = manager.execute('printf forbidden', {
        background: true,
        signal: new AbortController().signal,
      });
      await waitUntil(() => authorize.mock.calls.length === 1);
      await manager.dispose();
      pendingAuthorization.resolve({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS });

      await expect(pending).rejects.toThrow('closed');
      expect(manager.sessions).toEqual([]);
    });

    it('does not revive a terminal closed while authorization is pending', async () => {
      const { manager, authorize } = await fixture();
      const first = await manager.execute('printf ready', {
        background: true,
        signal: new AbortController().signal,
      });
      await waitUntil(() => manager.sessions[0]?.status === ShellSessionStatus.IDLE);
      const pendingAuthorization = deferredAuthorization();
      authorize.mockImplementationOnce(() => pendingAuthorization.promise);
      const pending = manager.execute('printf forbidden', {
        terminalId: first.terminalId,
        signal: new AbortController().signal,
      });
      await waitUntil(() => authorize.mock.calls.length === 2);
      await manager.close(first.terminalId);
      pendingAuthorization.resolve({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS });

      await expect(pending).rejects.toThrow('closed while permission was pending');
      expect(manager.sessions).toEqual([]);
    });

    it('bounds concurrently retained terminal slots', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-shell-limit-'));
      temporaryDirectories.push(root);
      const manager = new ShellSessionManager(
        {
          authorize: async () => ({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS }),
        } as unknown as ShellCommandAuthorizer,
        { resolve: async () => root } as unknown as ShellWorkingDirectoryResolver,
        launcher(root),
        undefined,
        undefined,
        1,
      );
      managers.push(manager);
      await manager.execute('sleep 1', { background: true, signal: new AbortController().signal });

      await expect(
        manager.execute('printf second', { background: true, signal: new AbortController().signal }),
      ).rejects.toThrow('At most 1');
    });

    it('rechecks capacity after concurrent authorizations resolve', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-shell-concurrent-limit-'));
      temporaryDirectories.push(root);
      const firstAuthorization = deferredAuthorization();
      const secondAuthorization = deferredAuthorization();
      const authorize = vi
        .fn<ShellCommandAuthorizer['authorize']>()
        .mockReturnValueOnce(firstAuthorization.promise)
        .mockReturnValueOnce(secondAuthorization.promise);
      const manager = new ShellSessionManager(
        { authorize } as unknown as ShellCommandAuthorizer,
        { resolve: async () => root } as unknown as ShellWorkingDirectoryResolver,
        launcher(root),
        undefined,
        undefined,
        1,
      );
      managers.push(manager);
      const first = manager.execute('printf first', {
        background: true,
        signal: new AbortController().signal,
      });
      const second = manager.execute('printf second', {
        background: true,
        signal: new AbortController().signal,
      });
      await waitUntil(() => authorize.mock.calls.length === 2);
      firstAuthorization.resolve({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS });
      secondAuthorization.resolve({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS });

      const results = await Promise.allSettled([first, second]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(manager.sessions).toHaveLength(1);
    });

    it('releases a new terminal slot when process launch fails synchronously', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-shell-launch-failure-'));
      temporaryDirectories.push(root);
      const manager = new ShellSessionManager(
        {
          authorize: async () => ({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS }),
        } as unknown as ShellCommandAuthorizer,
        { resolve: async () => root } as unknown as ShellWorkingDirectoryResolver,
        {
          launch: () => {
            throw new Error('sandbox helper missing');
          },
        },
      );
      managers.push(manager);

      await expect(
        manager.execute('printf blocked', { background: true, signal: new AbortController().signal }),
      ).rejects.toThrow('sandbox helper missing');
      expect(manager.sessions).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('kills shell-backgrounded descendants when the command exits', async () => {
      const { manager } = await fixture();
      await manager.execute('sleep 10 & echo $!', {
        background: true,
        signal: new AbortController().signal,
      });
      await waitUntil(() => manager.sessions[0]?.status === ShellSessionStatus.IDLE);
      const processId = Number(/\d+/u.exec(manager.sessions[0]?.outputTail ?? '')?.[0]);

      expect(Number.isInteger(processId)).toBe(true);
      await waitUntil(() => !processExists(processId));
    });
  });
});

async function fixture(): Promise<{
  manager: ShellSessionManager;
  authorize: ReturnType<typeof vi.fn<ShellCommandAuthorizer['authorize']>>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-shell-session-'));
  temporaryDirectories.push(root);
  const authorize = vi.fn<ShellCommandAuthorizer['authorize']>(async () => ({
    sandboxProfile: ShellSandboxProfile.FULL_ACCESS,
  }));
  const manager = new ShellSessionManager(
    { authorize } as unknown as ShellCommandAuthorizer,
    { resolve: async () => root } as unknown as ShellWorkingDirectoryResolver,
    launcher(root),
  );
  managers.push(manager);
  return { manager, authorize };
}

function launcher(root: string): NativeShellSandboxLauncher {
  return new NativeShellSandboxLauncher({
    binaryPath: join(root, 'unused-sandbox-helper'),
    workspaceRoots: [root],
    stateDirectory: join(root, 'state'),
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for shell state.');
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function deferredAuthorization(): {
  promise: Promise<{ sandboxProfile: ShellSandboxProfile }>;
  resolve: (value: { sandboxProfile: ShellSandboxProfile }) => void;
} {
  let resolve!: (value: { sandboxProfile: ShellSandboxProfile }) => void;
  return {
    promise: new Promise(value => {
      resolve = value;
    }),
    resolve,
  };
}
