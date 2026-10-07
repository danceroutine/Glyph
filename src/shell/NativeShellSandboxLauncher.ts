import { realpathSync, statSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { basename, delimiter, isAbsolute, relative, sep } from 'node:path';
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';
import type { ShellProcessLauncher } from './ShellProcessLauncher.ts';
import { ShellSandboxProfile } from './ShellSandboxProfile.ts';
import { WorkspaceAccessPolicy } from '../workspace/policy/WorkspaceAccessPolicy.ts';

export interface NativeShellSandboxLauncherOptions {
  readonly binaryPath: string;
  readonly workspaceRoots: readonly string[];
  readonly stateDirectory: string;
  readonly protectedPaths?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly accessPolicy?: WorkspaceAccessPolicy;
}

type SpawnProcess = (command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess;

/** Runs approved commands through the native fail-closed sandbox boundary. */
export class NativeShellSandboxLauncher implements ShellProcessLauncher {
  constructor(
    private readonly options: NativeShellSandboxLauncherOptions,
    private readonly spawnProcess: SpawnProcess = (command, arguments_, options_) =>
      spawn(command, arguments_, options_),
  ) {}

  launch(command: string, workingDirectory: string, authorization: ShellExecutionAuthorization): ChildProcess {
    const environment = this.options.environment ?? process.env;
    const fullAccessShell =
      process.platform === 'win32' ? (environment.ComSpec ?? 'cmd.exe') : (environment.SHELL ?? '/bin/sh');
    const common: SpawnOptions = {
      cwd: workingDirectory,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (authorization.sandboxProfile === ShellSandboxProfile.FULL_ACCESS) {
      const arguments_ = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
      return this.spawnProcess(fullAccessShell, arguments_, {
        ...common,
        env: { ...environment, TERM: 'dumb', NO_COLOR: '1' },
      });
    }
    const shell = sandboxShell(environment);
    const accessPolicy = this.options.accessPolicy ?? new WorkspaceAccessPolicy();
    const arguments_ = [
      '--profile',
      authorization.sandboxProfile === ShellSandboxProfile.READ_ONLY ? 'read-only' : 'workspace-write',
      '--working-directory',
      workingDirectory,
      '--state-directory',
      this.options.stateDirectory,
      ...this.options.workspaceRoots.flatMap(root => ['--workspace-root', root]),
      ...(this.options.protectedPaths ?? []).flatMap(path => ['--protected-path', path]),
      '--workspace-policy',
      JSON.stringify(accessPolicy.toJSON()),
      '--',
      shell.executable,
      ...shell.arguments(command),
    ];
    return this.spawnProcess(this.options.binaryPath, arguments_, {
      ...common,
      env: sandboxEnvironment(authorization.sandboxProfile, shell.executable, environment),
    });
  }
}

/**
 * Sandboxed commands retain the user's trusted shell syntax without loading
 * personal startup files. Startup hooks and credential variables would make a
 * nominally safe command execute hidden code or disclose secrets; commands
 * that need them must receive explicit outside-sandbox approval instead.
 */
function sandboxShell(environment: NodeJS.ProcessEnv): {
  executable: string;
  arguments: (command: string) => string[];
} {
  const executable = trustedShell(environment.SHELL) ?? '/bin/sh';
  switch (basename(executable)) {
    case 'bash':
      return { executable, arguments: command => ['--noprofile', '--norc', '-c', command] };
    case 'zsh':
      return { executable, arguments: command => ['-f', '-c', command] };
    case 'fish':
      return { executable, arguments: command => ['--no-config', '-c', command] };
    default:
      return { executable, arguments: command => ['-c', command] };
  }
}

function trustedShell(candidate: string | undefined): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  try {
    const resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile() || !trustedShellName(basename(resolved))) return undefined;
    return TRUSTED_SHELL_DIRECTORIES.some(directory => isInside(directory, resolved)) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function trustedShellName(name: string): boolean {
  return ['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'].includes(name);
}

function isInside(directory: string, candidate: string): boolean {
  const fromDirectory = relative(directory, candidate);
  return (
    fromDirectory === '' ||
    (!fromDirectory.startsWith(`..${sep}`) && fromDirectory !== '..' && !isAbsolute(fromDirectory))
  );
}

const TRUSTED_SHELL_DIRECTORIES = [
  '/bin',
  '/usr/bin',
  '/usr/local/bin',
  '/usr/local/Cellar',
  '/opt/homebrew/bin',
  '/opt/homebrew/Cellar',
  '/opt/local/bin',
  '/nix/store',
] as const;

function sandboxEnvironment(profile: ShellSandboxProfile, shell: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH:
      profile === ShellSandboxProfile.READ_ONLY ? trustedInspectionPath() : (source.PATH ?? trustedInspectionPath()),
    SHELL: shell,
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const name of ['HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'] as const) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('LC_') && value !== undefined) environment[name] = value;
  }
  return environment;
}

function trustedInspectionPath(): string {
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
}
