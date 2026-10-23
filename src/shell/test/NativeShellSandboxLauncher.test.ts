import { realpathSync, statSync, type Stats } from 'node:fs';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { delimiter } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { NativeShellSandboxLauncher } from '#src/shell/NativeShellSandboxLauncher.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';

vi.mock('node:fs', { spy: true });

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

    it('defaults full-access commands to the system shell', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        { binaryPath: '/sandbox', workspaceRoots: ['/project'], stateDirectory: '/state', environment: {} },
        spawn,
      );

      launcher.launch('pnpm test', '/project', { sandboxProfile: ShellSandboxProfile.FULL_ACCESS });

      expect(spawn).toHaveBeenCalledWith('/bin/sh', ['-lc', 'pnpm test'], {
        cwd: '/project',
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { TERM: 'dumb', NO_COLOR: '1' },
      });
    });

    it.each([
      [
        'a configured command processor',
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'C:\\Windows\\System32\\cmd.exe',
      ],
      ['the default command processor', {}, 'cmd.exe'],
    ])('runs full-access commands on Windows with %s', (_case, environment, executable) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', platform);
      });
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        { binaryPath: '/sandbox', workspaceRoots: ['/project'], stateDirectory: '/state', environment },
        spawn,
      );

      launcher.launch('dir', '/project', { sandboxProfile: ShellSandboxProfile.FULL_ACCESS });

      expect(spawn).toHaveBeenCalledWith(executable, ['/d', '/s', '/c', 'dir'], {
        cwd: '/project',
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...environment, TERM: 'dumb', NO_COLOR: '1' },
      });
    });

    it('selects the most specific workspace root containing the working directory', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/sandbox',
          workspaceRoots: ['/project', '/project/packages/app', '/other'],
          stateDirectory: '/state',
          environment: {},
        },
        spawn,
      );

      launcher.launch('ls', '/project/packages/app/src', { sandboxProfile: ShellSandboxProfile.READ_ONLY });

      const arguments_ = spawn.mock.calls[0]![1];
      expect(arguments_[arguments_.indexOf('--workspace-root') + 1]).toBe('/project/packages/app');
    });

    it('refuses working directories outside every workspace root', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>();
      const launcher = new NativeShellSandboxLauncher(
        { binaryPath: '/sandbox', workspaceRoots: ['/project'], stateDirectory: '/state', environment: {} },
        spawn,
      );

      expect(() => launcher.launch('ls', '/elsewhere', { sandboxProfile: ShellSandboxProfile.READ_ONLY })).toThrow(
        'Shell working directory must be inside a configured workspace root.',
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it.each([
      ['bash', '/usr/bin/bash', ['--noprofile', '--norc', '-c', 'ls']],
      ['zsh', '/bin/zsh', ['-f', '-c', 'ls']],
      ['fish', '/opt/homebrew/bin/fish', ['--no-config', '-c', 'ls']],
      ['dash', '/usr/bin/dash', ['-c', 'ls']],
    ])('disables %s startup files for sandboxed commands', (_shell, path, shellArguments) => {
      vi.mocked(realpathSync).mockReturnValueOnce(path);
      vi.mocked(statSync).mockReturnValueOnce({ isFile: () => true } as Stats);
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/sandbox',
          workspaceRoots: ['/project'],
          stateDirectory: '/state',
          environment: { SHELL: path },
        },
        spawn,
      );

      launcher.launch('ls', '/project', { sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE });

      expect(spawn.mock.calls[0]![1].slice(-(shellArguments.length + 1))).toEqual([path, ...shellArguments]);
      expect(spawn.mock.calls[0]![2].env).toMatchObject({ SHELL: path });
    });

    it.each([
      ['a relative shell', 'bash', undefined],
      ['a shell that is not a regular file', '/bin', { isFile: () => false }],
      ['an unrecognized program', '/bin/ls', { isFile: () => true }],
      ['a shell outside trusted directories', '/home/person/bin/bash', { isFile: () => true }],
    ])('falls back to the system shell for %s', (_case, shell, stats) => {
      if (stats) {
        vi.mocked(realpathSync).mockReturnValueOnce(shell);
        vi.mocked(statSync).mockReturnValueOnce(stats as Stats);
      }
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/sandbox',
          workspaceRoots: ['/project'],
          stateDirectory: '/state',
          environment: { SHELL: shell },
        },
        spawn,
      );

      launcher.launch('ls', '/project', { sandboxProfile: ShellSandboxProfile.READ_ONLY });

      expect(spawn.mock.calls[0]![1].slice(-3)).toEqual(['/bin/sh', '-c', 'ls']);
    });

    it('keeps locale settings and a trusted search path for sandboxed commands', () => {
      const spawn = vi.fn<(command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess>(
        () => ({}) as ChildProcess,
      );
      const launcher = new NativeShellSandboxLauncher(
        {
          binaryPath: '/sandbox',
          workspaceRoots: ['/project'],
          stateDirectory: '/state',
          environment: { LC_ALL: 'en_US.UTF-8', LC_CTYPE: undefined, USER: 'person', SECRET: 'hidden' },
        },
        spawn,
      );

      launcher.launch('make', '/project', { sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE });

      expect(spawn.mock.calls[0]![2].env).toEqual({
        PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
        SHELL: '/bin/sh',
        TERM: 'dumb',
        NO_COLOR: '1',
        USER: 'person',
        LC_ALL: 'en_US.UTF-8',
      });
    });
  });
});
