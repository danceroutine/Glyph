import { realpathSync, statSync } from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { basename, delimiter, isAbsolute, relative, sep } from 'node:path';
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';
import type { ShellProcessLauncher } from './ShellProcessLauncher.ts';
import type { ShellProgram } from './ShellProgram.ts';
import { externalShellContentStores, type ShellContentStore } from './ShellContentStore.ts';
import { pnpmContentStore } from './pnpmContentStore.ts';
import { ShellSandboxProfile } from './ShellSandboxProfile.ts';
import type { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';

export interface NativeShellSandboxLauncherOptions {
  readonly binaryPath: string;
  readonly contentStores?: (environment: NodeJS.ProcessEnv) => readonly ShellContentStore[];
  readonly workspaceRoots: readonly string[];
  readonly stateDirectory: string;
  readonly protectedPaths?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly accessPolicy: WorkspaceAccessPolicy;
}

type SpawnProcess = (command: string, arguments_: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Enforces the execution profile chosen by the shell authorizer. For a restricted command, snapshot the
 * host's shell policy, check it again immediately before spawn, and let the native helper establish the
 * OS sandbox for the child. A command explicitly approved for full access starts outside that sandbox.
 */
export class NativeShellSandboxLauncher implements ShellProcessLauncher {
  constructor(
    private readonly options: NativeShellSandboxLauncherOptions,
    private readonly spawnProcess: SpawnProcess = (command, arguments_, options_) =>
      spawn(command, arguments_, options_),
  ) {}

  launch(
    command: string,
    workingDirectory: string,
    authorization: ShellExecutionAuthorization,
    program?: ShellProgram,
  ): ChildProcess {
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
      return this.spawnProcess(program?.executable ?? fullAccessShell, program?.arguments ?? arguments_, {
        ...common,
        env: { ...environment, TERM: 'dumb', NO_COLOR: '1' },
      });
    }
    const shell = sandboxShell(environment);
    const accessPolicy = this.options.accessPolicy;
    const operation = accessPolicy.beginOperation();
    const workspaceRoot = mostSpecificWorkspaceRoot(this.options.workspaceRoots, workingDirectory);
    const stores = (this.options.contentStores ?? pnpmContentStore)(environment);
    const arguments_ = [
      '--profile',
      authorization.sandboxProfile === ShellSandboxProfile.READ_ONLY ? 'read-only' : 'workspace-write',
      '--working-directory',
      workingDirectory,
      '--state-directory',
      this.options.stateDirectory,
      '--workspace-root',
      workspaceRoot,
      ...(this.options.protectedPaths ?? []).flatMap(path => ['--protected-path', path]),
      ...operation.privatePaths.flatMap(path => ['--private-path', path]),
      ...(authorization.readOnlyPaths ?? []).flatMap(path => ['--read-only-path', path]),
      ...externalShellContentStores(stores, this.options.workspaceRoots).flatMap(store => [
        '--content-store',
        JSON.stringify(store),
      ]),
      '--workspace-policy',
      JSON.stringify(accessPolicy.toJSON()),
      '--',
      ...(program ? [program.executable, ...program.arguments] : [shell.executable, ...shell.arguments(command)]),
    ];
    operation.assertCurrent();
    return this.spawnProcess(this.options.binaryPath, arguments_, {
      ...common,
      env: sandboxEnvironment(authorization.sandboxProfile, shell.executable, environment),
    });
  }
}

function mostSpecificWorkspaceRoot(roots: readonly string[], workingDirectory: string): string {
  const matches = roots
    .filter(root => isInside(root, workingDirectory))
    .toSorted((left, right) => right.length - left.length);
  const root = matches[0];
  if (root === undefined || root === '')
    throw new Error('Shell working directory must be inside a configured workspace root.');
  return root;
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
  if (candidate === undefined || candidate === '' || !isAbsolute(candidate)) return undefined;
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
