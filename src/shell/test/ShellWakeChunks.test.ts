import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import type { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';

it.each(['Server \u001B[32mready\u001B[0m 🧪', 'Server \u001B]8;;https://example.test\u001B\\ready\u001B]8;;\u001B\\'])(
  'wakes for identical terminal bytes at every chunk boundary: %j',
  async output => {
    const bytes = Buffer.from(output);
    for (let split = 1; split < bytes.length; split++) {
      const child = new ChildProcess();
      const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
      Object.assign(child, streams);
      const manager = new ShellSessionManager(
        {
          authorize: async () => ({ sandboxProfile: ShellSandboxProfile.READ_ONLY }),
        } as unknown as ShellCommandAuthorizer,
        { resolve: async () => '/fixture' } as unknown as ShellWorkingDirectoryResolver,
        { launch: () => child },
      );
      const wakes: string[] = [];
      manager.onDidWake(event => {
        wakes.push(event.pattern);
      });
      try {
        await manager.execute('inert fixture', {
          background: true,
          wakeOn: 'Server ready',
          signal: new AbortController().signal,
        });
        streams.stdout.write(bytes.subarray(0, split));
        streams.stdout.write(bytes.subarray(split));
        expect(wakes, `split at byte ${split}`).toEqual(['Server ready']);
      } finally {
        child.emit('close', 0, null);
        await manager.dispose();
        for (const stream of Object.values(streams)) stream.destroy();
      }
    }
  },
);

it('revokes queued matches on close and retains final output until termination settles', async () => {
  const child = new ChildProcess();
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  Object.assign(child, streams);
  const manager = new ShellSessionManager(
    { authorize: async () => ({ sandboxProfile: ShellSandboxProfile.READ_ONLY }) } as unknown as ShellCommandAuthorizer,
    { resolve: async () => '/fixture' } as unknown as ShellWorkingDirectoryResolver,
    { launch: () => child },
  );
  const snapshots: unknown[] = [];
  manager.onDidChange(() => {
    snapshots.push(manager.allSessions[0]);
  });
  try {
    const result = await manager.execute('inert', {
      background: true,
      wakeOn: 'READY',
      ownerChatId: 'chat',
      signal: new AbortController().signal,
    });
    streams.stdout.write('READY');
    expect(manager.peekPendingWake(() => true)?.pattern).toBe('READY');
    const closing = manager.close(result.terminalId, 'chat');
    expect(manager.peekPendingWake(() => true)).toBeUndefined();
    await expect(
      manager.writeInput({
        terminalId: result.terminalId,
        ownerChatId: 'chat',
        input: 'late',
        appendNewline: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Unknown shell');
    streams.stdout.write(' final bytes');
    child.emit('close', null, 'SIGTERM');
    await closing;
    expect(snapshots).toContainEqual(
      expect.objectContaining({ outputTail: 'READY final bytes', exitCode: 128, stopRequested: true }),
    );
    expect(manager.allSessions).toHaveLength(0);
    expect(manager.peekPendingWake(() => true)).toBeUndefined();
  } finally {
    child.emit('close', 0, null);
    await manager.dispose();
    for (const stream of Object.values(streams)) stream.destroy();
  }
});

it('retains asynchronous process-launch failures in the background snapshot', async () => {
  const child = new ChildProcess();
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  Object.assign(child, streams);
  const manager = new ShellSessionManager(
    { authorize: async () => ({ sandboxProfile: ShellSandboxProfile.READ_ONLY }) } as unknown as ShellCommandAuthorizer,
    { resolve: async () => '/fixture' } as unknown as ShellWorkingDirectoryResolver,
    { launch: () => child },
  );
  try {
    await manager.execute('inert', { background: true, signal: new AbortController().signal });
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', -2, null);
    expect(manager.allSessions[0]).toMatchObject({ status: 'exited', error: 'spawn ENOENT' });
  } finally {
    child.emit('close', 0, null);
    await manager.dispose();
    for (const stream of Object.values(streams)) stream.destroy();
  }
});

it('rejects a delayed authorization when the retained terminal is already closing', async () => {
  const child = new ChildProcess();
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  Object.assign(child, streams);
  let approve!: () => void;
  const approval = new Promise<void>(resolve => {
    approve = resolve;
  });
  let authorizations = 0;
  let launches = 0;
  const manager = new ShellSessionManager(
    {
      authorize: async () => {
        if (++authorizations > 1) await approval;
        return { sandboxProfile: ShellSandboxProfile.READ_ONLY };
      },
    } as unknown as ShellCommandAuthorizer,
    { resolve: async () => '/fixture' } as unknown as ShellWorkingDirectoryResolver,
    {
      launch: () => {
        launches++;
        return child;
      },
    },
  );
  try {
    const result = await manager.execute('first', {
      background: true,
      ownerChatId: 'chat',
      signal: new AbortController().signal,
    });
    const pending = manager.execute('second', {
      terminalId: result.terminalId,
      background: true,
      ownerChatId: 'chat',
      signal: new AbortController().signal,
    });
    const rejected = expect(pending).rejects.toThrow('closed while permission was pending');
    const closing = manager.close(result.terminalId, 'chat');
    approve();
    await rejected;
    expect(launches).toBe(1);
    child.emit('close', 0, null);
    await closing;
  } finally {
    approve();
    child.emit('close', 0, null);
    await manager.dispose();
    for (const stream of Object.values(streams)) stream.destroy();
  }
});
