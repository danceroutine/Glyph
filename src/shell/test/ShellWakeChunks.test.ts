import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import type { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';

it.each(['Server \x1b[32mready\x1b[0m 🧪', 'Server \x1b]8;;https://example.test\x1b\\ready\x1b]8;;\x1b\\'])(
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
      manager.onDidWake(event => wakes.push(event.pattern));
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
