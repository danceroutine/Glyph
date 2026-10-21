import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { NativeShellSandboxLauncher } from '#src/shell/NativeShellSandboxLauncher.js';
import type { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';
import type { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';

const managers: ShellSessionManager[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ShellSessionManager, () => {
  describe('command lifecycle', () => {
    it('leaves the wake subscription unchanged when full-access input is rejected', async () => {
      const { manager } = await fixture(ShellSandboxProfile.FULL_ACCESS);
      const running = await manager.execute('read value', {
        background: true,
        wakeOn: 'ready',
        signal: new AbortController().signal,
      });
      await expect(
        manager.writeInput({
          terminalId: running.terminalId,
          input: 'input',
          appendNewline: true,
          wakeOn: 'replacement',
        }),
      ).rejects.toThrow('not authorized');
      expect(manager.sessions[0]?.wakePattern).toBe('ready');
    });

    it('does not combine output or inherit a wake condition across separate commands', async () => {
      const { manager } = await fixture();
      const wake = vi.fn();
      const stop = manager.onDidWake(wake);
      try {
        const first = await manager.execute('printf rea', {
          background: true,
          wakeOn: 'ready',
          signal: new AbortController().signal,
        });
        await waitUntil(() => manager.sessions[0]?.status === ShellSessionStatus.IDLE);
        await manager.execute('printf dy', {
          terminalId: first.terminalId,
          signal: new AbortController().signal,
        });
        expect.soft(wake).not.toHaveBeenCalled();
        expect.soft(manager.takePendingWake()).toBeUndefined();
        expect(manager.sessions[0]?.wakePattern).toBeUndefined();
        // Even a complete match in a later command must not reuse an old subscription.
        await manager.execute('printf ready', {
          terminalId: first.terminalId,
          signal: new AbortController().signal,
        });
        expect(wake).not.toHaveBeenCalled();
      } finally {
        stop();
      }
    });

    it('keeps the running command wake condition when a second command is rejected as busy', async () => {
      const { manager } = await fixture(ShellSandboxProfile.WORKSPACE_WRITE);
      const wake = vi.fn();
      const stop = manager.onDidWake(wake);
      try {
        const running = await manager.execute('read value; printf ready', {
          background: true,
          wakeOn: 'ready',
          signal: new AbortController().signal,
        });
        await expect(
          manager.execute('printf rejected', {
            terminalId: running.terminalId,
            wakeOn: 'different',
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow('busy');
        expect.soft(manager.sessions[0]?.wakePattern).toBe('ready');
        await manager.writeInput({ terminalId: running.terminalId, input: 'continue', appendNewline: true });
        await waitUntil(() => manager.sessions[0]?.status === ShellSessionStatus.IDLE);
        expect(wake).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'ready' }));
      } finally {
        stop();
      }
    });

    it('preserves terminal capacity after repeated invalid wake patterns', async () => {
      const { manager } = await fixture();
      for (let attempt = 0; attempt < 16; attempt++) {
        await expect(
          manager.execute('printf should-not-run', {
            wakeOn: '   ',
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow();
      }
      expect(manager.sessions).toEqual([]);
      await expect(
        manager.execute('printf available', { signal: new AbortController().signal }),
      ).resolves.toMatchObject({
        status: 'completed',
        output: 'available',
        exitCode: 0,
      });
    });

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
      const { manager } = await fixture(ShellSandboxProfile.WORKSPACE_WRITE);
      const command = await manager.execute('read value; printf "got:%s" "$value"', {
        background: true,
        signal: new AbortController().signal,
      });

      await manager.writeInput({
        terminalId: command.terminalId,
        input: 'answer',
        appendNewline: true,
        wakeOn: 'got:answer',
      });
      await waitUntil(
        () =>
          manager.sessions[0]?.status === ShellSessionStatus.IDLE &&
          manager.sessions[0]?.outputTail.includes('got:answer') === true,
      );

      expect(manager.takePendingWake()).toMatchObject({ pattern: 'got:answer' });
      expect(manager.sessions[0]?.outputTail).toContain('got:answer');
      await expect(
        manager.writeInput({ terminalId: command.terminalId, input: 'next', appendNewline: true }),
      ).rejects.toThrow('only allowed while');
    });

    it('does not treat raw input as authorization for a full-access command', async () => {
      const { manager } = await fixture();
      const command = await manager.execute('read value', {
        background: true,
        signal: new AbortController().signal,
      });

      await expect(
        manager.writeInput({ terminalId: command.terminalId, input: 'unreviewed', appendNewline: true }),
      ).rejects.toThrow('complete command can be reviewed');
      await manager.close(command.terminalId);
    });

    it('binds listing, reuse, input, and close capabilities to the owning chat', async () => {
      const { manager } = await fixture(ShellSandboxProfile.WORKSPACE_WRITE);
      manager.setOwnerChat('chat-one');
      const command = await manager.execute('read value', {
        background: true,
        signal: new AbortController().signal,
      });

      manager.setOwnerChat('chat-two');
      expect(manager.sessions).toEqual([]);
      expect(manager.sessionsFor('chat-two')).toEqual([]);
      await expect(
        manager.writeInput({ terminalId: command.terminalId, input: 'cross-chat', appendNewline: true }),
      ).rejects.toThrow('Unknown shell terminal');
      await expect(manager.close(command.terminalId)).rejects.toThrow('Unknown shell terminal');
      await expect(
        manager.execute('printf cross-chat', {
          terminalId: command.terminalId,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Unknown shell terminal');

      manager.setOwnerChat('chat-one');
      expect(manager.sessions).toHaveLength(1);
      await manager.close(command.terminalId);
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

  describe(ShellSessionManager.prototype.execute, () => {
    it('rejects a blank command without retaining a terminal', async () => {
      const { manager } = fakeShell([]);

      await expect(manager.execute('   ', { signal: new AbortController().signal })).rejects.toThrow(
        'Shell command cannot be empty.',
      );
      expect(manager.allSessions).toEqual([]);
    });

    it('records stderr output, execution IDs, and output that arrives after the command exits', async () => {
      const child = fakeChild();
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('build', {
        background: true,
        executionId: 'execution-1',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      child.stderr!.emit('data', 'warning\n');
      child.emit('close', 0, null);
      child.stdout!.emit('data', 'late output');

      expect(manager.sessionsFor('chat')).toEqual([
        expect.objectContaining({
          id: terminalId,
          executionId: 'execution-1',
          status: ShellSessionStatus.IDLE,
          exitCode: 0,
          outputTail: 'warning\nlate output',
        }),
      ]);
    });

    it('reports exit code 1 when a command closes without a code or signal', async () => {
      const child = fakeChild();
      const { manager, launch } = fakeShell([child]);

      const pending = manager.execute('mystery', { signal: new AbortController().signal });
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      child.stdout!.emit('data', 'partial');
      child.emit('close', null, null);

      await expect(pending).resolves.toMatchObject({ status: 'completed', output: 'partial', exitCode: 1 });
    });

    it('rejects a foreground command whose process fails', async () => {
      const child = fakeChild();
      const { manager, launch } = fakeShell([child]);

      const pending = manager.execute('missing-binary', { signal: new AbortController().signal });
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      child.emit('error', new Error('spawn ENOENT'));
      child.emit('close', -2, null);

      await expect(pending).rejects.toThrow('spawn ENOENT');
      expect(manager.allSessions).toEqual([]);
    });

    it('rejects a command cancelled while it is being launched', async () => {
      const child = fakeChild();
      const controller = new AbortController();
      const reason = new Error('Cancelled during launch');
      const { manager } = fakeShell([child], () => controller.abort(reason));

      const pending = manager.execute('slow start', { signal: controller.signal });
      const outcome = pending.catch((error: unknown) => error);
      await vi.waitFor(() => expect(manager.allSessions).toHaveLength(1));
      child.emit('close', null, 'SIGTERM');

      expect(await outcome).toBe(reason);
      expect(manager.allSessions).toEqual([]);
    });

    it('ignores failures reported by a previous process after the terminal is reused', async () => {
      const first = fakeChild();
      const second = fakeChild();
      const { manager } = fakeShell([first, second]);
      const { terminalId } = await manager.execute('first', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      first.emit('close', 0, null);
      await manager.execute('second', {
        terminalId,
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      first.emit('error', new Error('stale failure'));

      expect(manager.sessionsFor('chat')[0]).toMatchObject({ command: 'second', status: ShellSessionStatus.RUNNING });
      expect(manager.sessionsFor('chat')[0]).not.toHaveProperty('error');
    });
  });

  describe(ShellSessionManager.prototype.takePendingWake, () => {
    it('takes a specific wake by ID and keeps other terminals’ wakes when one terminal closes', async () => {
      const first = fakeChild();
      const second = fakeChild();
      const { manager } = fakeShell([first, second]);
      const firstTerminal = await manager.execute('serve one', {
        background: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      await manager.execute('serve two', {
        background: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      first.stdout!.emit('data', 'ready');
      second.stdout!.emit('data', 'ready');
      const [firstWake, secondWake] = [
        manager.peekPendingWake(event => event.command === 'serve one')!,
        manager.peekPendingWake(event => event.command === 'serve two')!,
      ];

      expect(manager.takePendingWake('missing')).toBeUndefined();
      expect(manager.takePendingWake(secondWake.id)).toEqual(secondWake);
      second.stdout!.emit('data', 'ready');
      expect(manager.takePendingWake()).toEqual(firstWake);
      expect(manager.takePendingWake()).toBeUndefined();
      first.stdout!.emit('data', 'ready again');
      expect(manager.takePendingWake()).toBeUndefined();
      expect(firstTerminal.terminalId).toBe(firstWake.terminalId);
    });

    it('keeps wakes from other terminals when a terminal closes', async () => {
      const first = fakeChild();
      const second = fakeChild();
      const { manager } = fakeShell([first, second]);
      const firstTerminal = await manager.execute('serve one', {
        background: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      await manager.execute('serve two', {
        background: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      second.stdout!.emit('data', 'ready');
      first.stdout!.emit('data', 'ready');

      const closing = manager.close(firstTerminal.terminalId, 'chat');
      first.emit('close', 0, null);
      await closing;

      expect(manager.takePendingWake()).toMatchObject({ command: 'serve two' });
      expect(manager.takePendingWake()).toBeUndefined();
    });
  });

  describe(ShellSessionManager.prototype.writeInput, () => {
    it('writes input without a trailing newline when requested', async () => {
      const child = fakeChild();
      const written: string[] = [];
      child.stdin!.on('data', chunk => written.push(String(chunk)));
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      await manager.writeInput({ terminalId, input: 'raw', appendNewline: false, ownerChatId: 'chat' });

      expect(written).toEqual(['raw']);
    });

    it('rejects a blank wake pattern', async () => {
      const child = fakeChild();
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      await expect(
        manager.writeInput({ terminalId, input: 'x', appendNewline: true, wakeOn: '   ', ownerChatId: 'chat' }),
      ).rejects.toThrow('Shell wake pattern cannot be empty.');
    });

    it('reports a failed write that had no replacement wake condition', async () => {
      const child = fakeChild();
      Object.assign(child, {
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            done(new Error('write EPIPE'));
          },
        }),
      });
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      await expect(
        manager.writeInput({ terminalId, input: 'x', appendNewline: true, ownerChatId: 'chat' }),
      ).rejects.toThrow('write EPIPE');
      expect(manager.sessionsFor('chat')[0]?.wakePattern).toBe('ready');
    });

    it.each([
      ['an error', new Error('pipe exploded'), 'pipe exploded'],
      ['a non-error value', 'pipe exploded', 'pipe exploded'],
    ])('rejects when writing to the pipe throws %s', async (_case, thrown, message) => {
      const child = fakeChild();
      Object.assign(child.stdin!, {
        write: () => {
          throw thrown;
        },
      });
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      const failure = await manager
        .writeInput({ terminalId, input: 'x', appendNewline: true, wakeOn: 'next', ownerChatId: 'chat' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message });
    });

    it('rejects with a generic cancellation when the signal carries no reason', async () => {
      const child = fakeChild();
      let complete: ((error?: Error | null) => void) | undefined;
      Object.assign(child, {
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            complete = done;
          },
        }),
      });
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      const signal = Object.assign(new EventTarget(), { aborted: false, reason: undefined, throwIfAborted: () => {} });

      const pending = manager.writeInput({
        terminalId,
        input: 'x',
        appendNewline: true,
        wakeOn: 'replacement',
        ownerChatId: 'chat',
        signal: signal as unknown as AbortSignal,
      });
      await vi.waitFor(() => expect(complete).toBeDefined());
      signal.dispatchEvent(new Event('abort'));

      await expect(pending).rejects.toThrow('Shell input cancelled.');
      complete!(new Error('late failure'));
      expect(manager.sessionsFor('chat')[0]?.wakePattern).toBe('ready');
    });

    it('rejects input acknowledged only after its command has ended', async () => {
      const child = fakeChild();
      let complete: ((error?: Error | null) => void) | undefined;
      Object.assign(child, {
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            complete = done;
          },
        }),
      });
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      const pending = manager.writeInput({ terminalId, input: 'x', appendNewline: true, ownerChatId: 'chat' });
      await vi.waitFor(() => expect(complete).toBeDefined());
      manager.onDidChange(() => {
        if (manager.sessionsFor('chat')[0]?.status !== ShellSessionStatus.IDLE) return;
        const accept = complete;
        complete = undefined;
        accept?.();
      });

      child.emit('close', 0, null);

      await expect(pending).rejects.toThrow('The shell command ended before accepting the input.');
    });

    it('wakes once when the replacement pattern appears repeatedly before the write is accepted', async () => {
      const child = fakeChild();
      let complete: ((error?: Error | null) => void) | undefined;
      Object.assign(child, {
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            complete = done;
          },
        }),
      });
      const { manager } = fakeShell([child]);
      const wake = vi.fn();
      manager.onDidWake(wake);
      const { terminalId } = await manager.execute('read value', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      const pending = manager.writeInput({
        terminalId,
        input: 'x',
        appendNewline: true,
        wakeOn: 'ready',
        ownerChatId: 'chat',
      });
      await vi.waitFor(() => expect(complete).toBeDefined());

      child.stdout!.emit('data', 'ready');
      child.stdout!.emit('data', 'ready again');
      complete!();
      await pending;

      expect(wake).toHaveBeenCalledOnce();
      expect(wake).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'ready', terminalId }));
    });
  });

  describe(ShellSessionManager.prototype.close, () => {
    it('escalates on Windows by signalling the process directly', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const child = fakeChild();
      Object.assign(child, { pid: 4242, exitCode: null, signalCode: null });
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('Not supported'), { code: 'EINVAL' });
      });
      onTestFinished(() => kill.mockRestore());
      const childKill = vi.spyOn(child, 'kill').mockReturnValue(true);
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('serve', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      let closing: Promise<void>;
      try {
        closing = manager.close(terminalId, 'chat');
        Object.assign(child, { pid: undefined });
        child.emit('close', null, 'SIGTERM');
        await vi.advanceTimersByTimeAsync(2_000);
        await closing;
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }

      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(childKill).toHaveBeenCalledWith('SIGTERM');
      expect(childKill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('skips group escalation once the process identifier is no longer available', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const child = fakeChild();
      Object.assign(child, { pid: 4242, exitCode: null, signalCode: null });
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      onTestFinished(() => kill.mockRestore());
      const { manager } = fakeShell([child]);
      const { terminalId } = await manager.execute('serve', {
        background: true,
        ownerChatId: 'chat',
        signal: new AbortController().signal,
      });

      const closing = manager.close(terminalId, 'chat');
      Object.assign(child, { pid: undefined });
      child.emit('close', null, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(2_000);
      await closing;

      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(kill).not.toHaveBeenCalledWith(expect.anything(), 'SIGKILL');
    });
  });
});

function fakeChild(): ChildProcess {
  const child = new ChildProcess();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

function fakeShell(children: ChildProcess[], onLaunch: () => void = () => {}) {
  const queue = [...children];
  let id = 0;
  const launch = vi.fn(() => {
    onLaunch();
    const child = queue.shift();
    if (!child) throw new Error('No fake process remains.');
    return child;
  });
  const manager = new ShellSessionManager(
    { authorize: async () => ({ sandboxProfile: ShellSandboxProfile.READ_ONLY }) } as unknown as ShellCommandAuthorizer,
    { resolve: async () => '/fixture' } as unknown as ShellWorkingDirectoryResolver,
    { launch },
    () => `id-${++id}`,
  );
  onTestFinished(async () => {
    for (const child of children) child.emit('close', 0, null);
    await manager.dispose();
  });
  return { manager, launch };
}

async function fixture(profile = ShellSandboxProfile.FULL_ACCESS): Promise<{
  manager: ShellSessionManager;
  authorize: ReturnType<typeof vi.fn<ShellCommandAuthorizer['authorize']>>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-shell-session-'));
  temporaryDirectories.push(root);
  const authorize = vi.fn<ShellCommandAuthorizer['authorize']>(async () => ({
    sandboxProfile: profile,
  }));
  const nativeLauncher = launcher(root);
  const manager = new ShellSessionManager(
    { authorize } as unknown as ShellCommandAuthorizer,
    { resolve: async () => root } as unknown as ShellWorkingDirectoryResolver,
    profile === ShellSandboxProfile.FULL_ACCESS
      ? nativeLauncher
      : {
          launch: (command, workingDirectory) =>
            nativeLauncher.launch(command, workingDirectory, {
              sandboxProfile: ShellSandboxProfile.FULL_ACCESS,
            }),
        },
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
