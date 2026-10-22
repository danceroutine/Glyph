import { ChildProcess } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellToolName } from '#src/shell/ShellToolName.js';
import { ShellToolRuntime } from '#src/shell/ShellToolRuntime.js';
import type { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()));
});

describe('interactive shell input completion', () => {
  it.each([
    { previous: 'ready', replacement: 'ready', chunks: ['ready'] },
    { previous: 'ready', replacement: 'server ready', chunks: ['server ', 'rea', 'dy'] },
    { previous: 'server ready', replacement: 'ready', chunks: ['server rea', 'dy'] },
    { previous: 'ready', replacement: 'listening', chunks: ['ready, then list', 'ening'] },
  ])('publishes only the accepted replacement subscription for $previous → $replacement', async test => {
    const fixture = await shellFixture(test.previous);
    const wake = vi.fn();
    fixture.manager.onDidWake(wake);
    const pending = fixture.write('start next operation', test.replacement);
    for (const chunk of test.chunks) fixture.stdout.write(chunk);
    fixture.completeWrite();
    expect(await pending).toMatchObject({ status: 'input_written' });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: test.replacement });
    expect(fixture.manager.takePendingWake()).toBeUndefined();
    fixture.stdout.write(test.replacement);
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it.each(['failed', 'cancelled'] as const)(
    'restores the old subscription and its split match when a replacement write is %s',
    async outcome => {
      const fixture = await shellFixture('ready');
      fixture.stdout.write('re');
      const controller = new AbortController();
      const pending = fixture.write('answer', 'ready', controller.signal);
      fixture.stdout.write('ady');
      expect(fixture.manager.takePendingWake()).toBeUndefined();
      if (outcome === 'failed') {
        fixture.completeWrite(new Error('write EPIPE'));
        expect(await pending).toMatchObject({ error: { code: 'SHELL_FAILED' } });
      } else {
        const rejected = expect(pending).rejects.toThrow('cancelled');
        controller.abort(new Error('cancelled'));
        await rejected;
      }
      expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: 'ready' });
      if (outcome === 'cancelled') fixture.completeWrite();
      expect(fixture.manager.takePendingWake()).toBeUndefined();
      fixture.stdout.write('ready');
      expect(fixture.manager.takePendingWake()).toBeUndefined();
    },
  );

  it('keeps the original wake live while input without a replacement condition is pending', async () => {
    const fixture = await shellFixture('ready');
    const pending = fixture.write('answer');
    fixture.stdout.write('ready');
    expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: 'ready' });
    fixture.completeWrite();
    expect(await pending).toMatchObject({ status: 'input_written' });
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it.each(['accepted', 'failed', 'cancelled'] as const)(
    'preserves only the surviving subscription suffix across an %s write boundary',
    async outcome => {
      const fixture = await shellFixture('original ready');
      fixture.stdout.write('original ');
      const controller = new AbortController();
      const pending = fixture.write('answer', 'ready', controller.signal);
      fixture.stdout.write('rea');
      if (outcome === 'accepted') {
        fixture.completeWrite();
        expect(await pending).toMatchObject({ status: 'input_written' });
      } else if (outcome === 'failed') {
        fixture.completeWrite(new Error('write EPIPE'));
        expect(await pending).toMatchObject({ error: { code: 'SHELL_FAILED' } });
      } else {
        const rejected = expect(pending).rejects.toThrow('cancelled');
        controller.abort(new Error('cancelled'));
        await rejected;
      }
      fixture.stdout.write('dy');
      expect(fixture.manager.takePendingWake()).toMatchObject({
        pattern: outcome === 'accepted' ? 'ready' : 'original ready',
      });
      if (outcome === 'cancelled') fixture.completeWrite();
      expect(fixture.manager.takePendingWake()).toBeUndefined();
    },
  );

  it('allows another occurrence to wake after an earlier subscription has already fired', async () => {
    const fixture = await shellFixture('ready');
    fixture.stdout.write('ready');
    expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: 'ready' });
    const pending = fixture.write('next answer', 'ready');
    fixture.stdout.write('ready');
    fixture.completeWrite();
    expect(await pending).toMatchObject({ status: 'input_written' });
    expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: 'ready' });
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it.each(['close', 'dispose'] as const)('discards buffered replacement wakes during terminal %s', async action => {
    const fixture = await shellFixture('ready');
    const wake = vi.fn();
    fixture.manager.onDidWake(wake);
    const pending = fixture.write('answer', 'ready');
    fixture.stdout.write('ready');
    const closing = action === 'close' ? fixture.manager.close(fixture.terminalId, 'chat') : fixture.manager.dispose();
    expect(await pending).toMatchObject({ error: { code: 'SHELL_FAILED' } });
    fixture.child.emit('close', 0, null);
    await closing;
    expect(wake).not.toHaveBeenCalled();
    expect(fixture.manager.takePendingWake()).toBeUndefined();
    fixture.completeWrite();
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it('preserves the old readiness match when its command naturally exits before input acknowledgement', async () => {
    const fixture = await shellFixture('ready');
    const pending = fixture.write('answer', 'ready');
    fixture.stdout.write('ready');
    fixture.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ error: { code: 'SHELL_FAILED' } });
    expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: 'ready' });
    fixture.completeWrite();
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it('reports pipe failures instead of successful writes and preserves the existing wake condition', async () => {
    const fixture = await shellFixture();
    const first = fixture.write('answer', 'new readiness');
    fixture.stdout.write('new readiness');
    fixture.completeWrite(new Error('write EPIPE'));
    expect(await first).toMatchObject({ error: { code: 'SHELL_FAILED', message: 'write EPIPE' } });
    expect(await fixture.write('second answer', 'other readiness')).toMatchObject({
      error: { code: 'SHELL_FAILED' },
    });
    expect(fixture.writes).toEqual(['answer\n']);
    expect(fixture.manager.sessionsFor('chat')[0]?.wakePattern).toBe('original readiness');
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it('acknowledges input only after the pipe accepts it and observes readiness output before acknowledgement', async () => {
    const fixture = await shellFixture();
    const settled = vi.fn();
    const write = fixture.write('answer', 'new readiness').then(result => {
      settled();
      return result;
    });
    fixture.stdout.write('new rea');
    fixture.stdout.write('diness');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(fixture.manager.takePendingWake()).toBeUndefined();
    fixture.completeWrite();
    expect(await write).toMatchObject({ status: 'input_written' });
    expect(fixture.manager.takePendingWake()).toMatchObject({ pattern: 'new readiness' });
  });

  it.each(['destroyed', 'ended'] as const)(
    'rejects an already %s input pipe without changing its wake subscription',
    async state => {
      const fixture = await shellFixture();
      if (state === 'destroyed') fixture.stdin.destroy();
      else fixture.stdin.end();
      expect(await fixture.write('answer', 'new readiness')).toMatchObject({ error: { code: 'SHELL_FAILED' } });
      expect(fixture.writes).toEqual([]);
      expect(fixture.manager.sessionsFor('chat')[0]?.wakePattern).toBe('original readiness');
    },
  );

  it('rejects overlapping writes without replacing either the running or pending wake condition', async () => {
    const fixture = await shellFixture();
    const first = fixture.write('first', 'first readiness');
    expect(await fixture.write('second', 'second readiness')).toMatchObject({ error: { code: 'SHELL_FAILED' } });
    expect(fixture.writes).toEqual(['first\n']);
    fixture.completeWrite();
    expect(await first).toMatchObject({ status: 'input_written' });
    expect(fixture.manager.sessionsFor('chat')[0]?.wakePattern).toBe('first readiness');
  });

  it('does not dispatch cancelled input and cancels a pending caller without committing its wake condition', async () => {
    const fixture = await shellFixture();
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled before write'));
    await expect(fixture.write('never write', 'new readiness', cancelled.signal)).rejects.toThrow(
      'cancelled before write',
    );
    expect(fixture.writes).toEqual([]);
    const controller = new AbortController();
    const pending = fixture.write('pending', 'new readiness', controller.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled during write');
    controller.abort(new Error('cancelled during write'));
    await rejected;
    expect(await fixture.write('overlapping input', 'other readiness')).toMatchObject({
      error: { code: 'SHELL_FAILED' },
    });
    expect(fixture.writes).toEqual(['pending\n']);
    // Cancellation cannot retract bytes already handed to the pipe, but it must
    // neither report success nor publish a new subscription on late completion.
    fixture.completeWrite();
    expect(fixture.manager.sessionsFor('chat')[0]?.wakePattern).toBe('original readiness');
  });

  it.each(['pipe', 'terminal'] as const)(
    'rejects pending input on %s closure even when its write callback never arrives',
    async target => {
      const fixture = await shellFixture();
      const pending = fixture.write('answer', 'new readiness');
      const closing = target === 'terminal' ? fixture.manager.close(fixture.terminalId, 'chat') : undefined;
      if (target === 'pipe') fixture.stdin.destroy();
      expect(await pending).toMatchObject({ error: { code: 'SHELL_FAILED' } });
      fixture.child.emit('close', 0, null);
      await closing;
      expect(fixture.stdin.listenerCount('close')).toBe(0);
      expect(fixture.manager.takePendingWake()).toBeUndefined();
    },
  );

  it.each(['x', 'xx', 'x'.repeat(32)])('bounds unmatched output retained for wake pattern %j', async pattern => {
    const fixture = await shellFixture(pattern);
    for (let index = 0; index < 10; index++) fixture.stdout.write('unmatched output '.repeat(100));
    // A retention bound is an internal invariant, unlike an emitted wake. Read
    // just that buffer so this regression cannot pass while keeping all output.
    const retained = fixture.manager as unknown as {
      terminals: Map<string, { wakeScanTail: string }>;
    };
    expect(retained.terminals.get(fixture.terminalId)?.wakeScanTail.length).toBeLessThanOrEqual(pattern.length - 1);
    expect(fixture.manager.takePendingWake()).toBeUndefined();
  });

  it('rejects an unacknowledged write when its command exits and cannot configure the next command', async () => {
    const fixture = await shellFixture();
    const pending = fixture.write('answer', 'old command readiness');
    fixture.child.emit('close', 0, null);
    expect(await pending).toMatchObject({ error: { code: 'SHELL_FAILED' } });
    await fixture.manager.execute('next inert command', {
      terminalId: fixture.terminalId,
      background: true,
      wakeOn: 'next command readiness',
      ownerChatId: 'chat',
      signal: new AbortController().signal,
    });
    fixture.completeWrite();
    expect(fixture.manager.sessionsFor('chat')[0]?.wakePattern).toBe('next command readiness');
  });
});

async function shellFixture(wakeOn = 'original readiness') {
  const child = new ChildProcess();
  const writes: string[] = [];
  let callback: ((error?: Error | null) => void) | undefined;
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      writes.push(String(chunk));
      callback = done;
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  const manager = new ShellSessionManager(
    { authorize: async () => ({ sandboxProfile: ShellSandboxProfile.READ_ONLY }) } as unknown as ShellCommandAuthorizer,
    { resolve: async () => '/fixture' } as unknown as ShellWorkingDirectoryResolver,
    { launch: () => child },
  );
  cleanup.push(async () => {
    child.emit('close', 0, null);
    await manager.dispose();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });
  const { terminalId } = await manager.execute('inert command', {
    background: true,
    wakeOn,
    ownerChatId: 'chat',
    signal: new AbortController().signal,
  });
  const runtime = new ShellToolRuntime(manager);
  return {
    manager,
    child,
    stdin,
    stdout,
    terminalId,
    writes,
    completeWrite(error?: Error) {
      if (!callback) throw new Error('No pending fixture write.');
      const complete = callback;
      callback = undefined;
      complete(error);
    },
    async write(input: string, wakePattern?: string, signal = new AbortController().signal) {
      const result = await runtime.execute(
        ShellToolName.WRITE_INPUT,
        JSON.stringify({ terminal_id: terminalId, input, append_newline: true, wake_on: wakePattern ?? null }),
        signal,
        { chat: { id: 'chat', accountId: 'account', accountProvider: 'fixture' } },
      );
      return JSON.parse(result) as Record<string, unknown>;
    },
  };
}
