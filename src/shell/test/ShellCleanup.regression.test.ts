import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';

describe('Shell cleanup after parent exit', () => {
  it.each(['close', 'dispose'] as const)(
    '[review-08] escalates %s to SIGKILL when an exited parent leaves descendants holding its output pipes',
    async operation => {
      vi.useFakeTimers();
      // No process is spawned or signalled: this models Node's distinct exit
      // and close events, with a descendant retaining the output pipes.
      const child = new ChildProcess();
      const pipes = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
      Object.assign(child, pipes, { pid: 424242, exitCode: null });
      const signals = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 'SIGKILL') child.emit('close', 0, null);
        return true;
      });
      const authorizer = new ShellCommandAuthorizer(
        'fixture',
        {
          load: async () => undefined,
          save: async () => {},
        },
        { presentShellPermission: async () => ShellPermissionDecision.DENY },
      );
      vi.spyOn(authorizer, 'authorize').mockResolvedValue({ sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE });
      const directories = new ShellWorkingDirectoryResolver({
        id: 'fixture',
        mutationIdentity: 'fixture',
        kind: ProjectContextKind.FOLDER,
        name: 'fixture',
        authority: 'file',
        roots: [{ name: 'fixture', path: '/fixture' }],
      });
      vi.spyOn(directories, 'resolve').mockResolvedValue('/fixture');
      const manager = new ShellSessionManager(authorizer, directories, { launch: () => child });
      let completion: Promise<void> | undefined;
      try {
        const command = await manager.execute('fixture-only command', {
          background: true,
          signal: new AbortController().signal,
        });
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
        let settled = false;
        completion = operation === 'close' ? manager.close(command.terminalId) : manager.dispose();
        void completion.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(3_000);
        expect.soft(signals).toHaveBeenCalledWith(-424242, 'SIGKILL');
        expect.soft(settled).toBe(true);
      } finally {
        // Force only the fake close event so a failing regression cannot leave
        // a timer, unresolved cleanup, or child process behind.
        child.emit('close', 0, null);
        await completion;
        await manager.dispose();
        for (const pipe of Object.values(pipes)) pipe.destroy();
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );
});
