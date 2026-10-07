import { realpathSync } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { NativeShellSandboxLauncher } from '../NativeShellSandboxLauncher.ts';
import { ShellSandboxProfile } from '../ShellSandboxProfile.ts';

describe(NativeShellSandboxLauncher, () => {
  describe(NativeShellSandboxLauncher.prototype.launch, () => {
    it('routes restricted commands through the helper with a sanitized environment', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/bin/glyph-shell-sandbox',
          workspaceRoots: ['/project', '/second'],
          stateDirectory: '/state',
          protectedPaths: ['/project/worker'],
          environment: {
            HOME: '/home/person',
            OPENAI_API_KEY: 'not-for-the-child',
            PATH: '/project/bin:/usr/bin',
            SHELL: '/project/malicious-shell',
          },
        },
        spawn,
      );

      launcher.launch('rg needle', '/project/src', { sandboxProfile: ShellSandboxProfile.READ_ONLY });

      expect(spawn).toHaveBeenCalledOnce();
      const [executable, arguments_, options] = spawn.mock.calls[0]!;
      expect(executable).toBe('/bin/glyph-shell-sandbox');
      expect(arguments_).toEqual(
        expect.arrayContaining([
          '--profile',
          'read-only',
          '--working-directory',
          '/project/src',
          '--state-directory',
          '/state',
          '--workspace-root',
          '/project',
          '--protected-path',
          '/project/worker',
        ]),
      );
      expect(arguments_).not.toContain('/second');
      expect(arguments_.slice(-3)).toEqual(['/bin/sh', '-c', 'rg needle']);
      const policyIndex = arguments_.indexOf('--workspace-policy');
      expect(JSON.parse(arguments_[policyIndex + 1]!)).toMatchObject({
        sensitiveFileNames: expect.arrayContaining(['.git-credentials']),
      });
      expect(options.cwd).toBe('/project/src');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(options.env).toMatchObject({ HOME: '/home/person', SHELL: '/bin/sh' });
      expect(options.env?.PATH).not.toContain('/project');
    });

    it('uses the configured trusted shell without loading personal startup files', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const shell = realpathSync('/bin/sh');
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/sandbox',
          workspaceRoots: ['/project'],
          stateDirectory: '/state',
          environment: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh' },
        },
        spawn,
      );

      launcher.launch('printf ready', '/project', { sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE });

      expect(spawn.mock.calls[0]?.[1].slice(-3)).toEqual([shell, '-c', 'printf ready']);
      expect(spawn.mock.calls[0]?.[2].env).toMatchObject({ PATH: '/usr/bin:/bin', SHELL: shell });
    });

    it('only bypasses the helper for an explicit full-access authorization', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/sandbox',
          workspaceRoots: ['/project'],
          stateDirectory: '/state',
          environment: {
            GLYPH_TEST_TOKEN: 'available-outside-the-sandbox',
            PATH: '/custom/bin:/usr/bin',
            SHELL: '/bin/sh',
          },
        },
        spawn,
      );

      launcher.launch('pnpm test', '/project', { sandboxProfile: ShellSandboxProfile.FULL_ACCESS });

      expect(spawn.mock.calls[0]?.[0]).toBe('/bin/sh');
      expect(spawn.mock.calls[0]?.[1]).toContain('-lc');
      expect(spawn.mock.calls[0]?.[2].env).toMatchObject({
        GLYPH_TEST_TOKEN: 'available-outside-the-sandbox',
        PATH: '/custom/bin:/usr/bin',
      });
    });
  });
});
