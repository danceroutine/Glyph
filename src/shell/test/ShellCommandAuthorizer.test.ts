import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileShellPermissionStore } from '../FileShellPermissionStore.ts';
import { ShellCommandAuthorizer } from '../ShellCommandAuthorizer.ts';
import { ShellPermissionDecision } from '../ShellPermissionDecision.ts';
import { ShellPermissionMode } from '../ShellPermissionPolicy.ts';
import { ShellSandboxProfile } from '../ShellSandboxProfile.ts';
import { isSafeShellCommand } from '../isSafeShellCommand.ts';
import type { ShellPermissionPresenter } from '../ShellPermissionPresenter.ts';
import type { ShellPermissionStore } from '../ShellPermissionStore.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ShellCommandAuthorizer, () => {
  describe(ShellCommandAuthorizer.prototype.authorize, () => {
    it('asks once, trims the command, and does not persist an allow-once decision', async () => {
      const presentShellPermission = vi.fn<ShellPermissionPresenter['presentShellPermission']>(
        async () => ShellPermissionDecision.ALLOW_ONCE,
      );
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission,
      });

      await expect(authorizer.authorize('  pnpm test  ', '/project', new AbortController().signal)).resolves.toEqual({
        sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE,
      });
      await authorizer.authorize('pnpm test', '/project', new AbortController().signal);

      expect(presentShellPermission).toHaveBeenCalledTimes(2);
      expect(presentShellPermission).toHaveBeenCalledWith(
        { command: 'pnpm test', workingDirectory: '/project' },
        expect.any(AbortSignal),
      );
      expect(save).not.toHaveBeenCalled();
    });

    it('serializes concurrent authorization and remembers an exact command', async () => {
      const presentShellPermission = vi.fn<ShellPermissionPresenter['presentShellPermission']>(
        async () => ShellPermissionDecision.ALWAYS_ALLOW,
      );
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission,
      });

      await Promise.all([
        authorizer.authorize('pnpm test', '/project', new AbortController().signal),
        authorizer.authorize('pnpm test', '/project', new AbortController().signal),
      ]);

      expect(presentShellPermission).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledWith({
        schemaVersion: 1,
        projectContextId: 'project',
        mode: ShellPermissionMode.ASK,
        allowedCommands: ['pnpm test'],
      });
    });

    it('persists allow-everything and skips all later prompts', async () => {
      const presentShellPermission = vi.fn<ShellPermissionPresenter['presentShellPermission']>(
        async () => ShellPermissionDecision.ALLOW_EVERYTHING,
      );
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission,
      });

      await authorizer.authorize('pnpm test', '/project', new AbortController().signal);
      await authorizer.authorize('rm one-file', '/project', new AbortController().signal);

      expect(authorizer.mode).toBe(ShellPermissionMode.ALLOW_EVERYTHING);
      expect(presentShellPermission).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledOnce();
    });

    it('persists allow-safe and only auto-approves simple foreground inspections', async () => {
      const presentShellPermission = vi
        .fn<ShellPermissionPresenter['presentShellPermission']>()
        .mockResolvedValueOnce(ShellPermissionDecision.ALLOW_SAFE)
        .mockResolvedValueOnce(ShellPermissionDecision.ALLOW_ONCE)
        .mockResolvedValueOnce(ShellPermissionDecision.ALLOW_ONCE);
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission,
      });

      await expect(authorizer.authorize('pnpm test', '/project', signal())).resolves.toEqual({
        sandboxProfile: ShellSandboxProfile.WORKSPACE_WRITE,
      });
      await expect(authorizer.authorize('rg "needle" src', '/project', signal())).resolves.toEqual({
        sandboxProfile: ShellSandboxProfile.READ_ONLY,
      });
      await authorizer.authorize('rg needle src', '/project', signal(), {
        background: true,
        existingTerminal: false,
      });
      await authorizer.authorize('cat file', '/project', signal(), {
        background: false,
        existingTerminal: true,
      });

      expect(authorizer.mode).toBe(ShellPermissionMode.ALLOW_SAFE);
      expect(presentShellPermission).toHaveBeenCalledTimes(3);
      expect(save).toHaveBeenCalledWith({
        schemaVersion: 1,
        projectContextId: 'project',
        mode: ShellPermissionMode.ALLOW_SAFE,
        allowedCommands: [],
      });
    });

    it('requires an explicit decision to leave the sandbox', async () => {
      const authorizer = new ShellCommandAuthorizer('project', store(), {
        presentShellPermission: async () => ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE,
      });

      await expect(authorizer.authorize('curl example.test', '/project', signal())).resolves.toEqual({
        sandboxProfile: ShellSandboxProfile.FULL_ACCESS,
      });
    });

    it('loads a saved policy before prompting', async () => {
      const presentShellPermission = vi.fn<ShellPermissionPresenter['presentShellPermission']>();
      const authorizer = new ShellCommandAuthorizer(
        'project',
        store({
          schemaVersion: 1,
          projectContextId: 'project',
          mode: ShellPermissionMode.ASK,
          allowedCommands: ['pnpm test'],
        }),
        { presentShellPermission },
      );

      await authorizer.initialize();
      await authorizer.initialize();
      await authorizer.authorize('pnpm test', '/project', new AbortController().signal);

      expect(presentShellPermission).not.toHaveBeenCalled();
    });

    it('rejects denied and empty commands', async () => {
      const authorizer = new ShellCommandAuthorizer('project', store(), {
        presentShellPermission: async () => ShellPermissionDecision.DENY,
      });

      await expect(authorizer.authorize('pnpm test', '/project', new AbortController().signal)).rejects.toThrow(
        'denied',
      );
      await expect(authorizer.authorize('   ', '/project', new AbortController().signal)).rejects.toThrow(
        'cannot be empty',
      );
    });
  });
});

describe(isSafeShellCommand, () => {
  it.each(['pwd', 'ls -la src', 'rg "a phrase" src'])('recognizes the bounded inspection command %s', command => {
    expect(isSafeShellCommand(command)).toBe(true);
  });

  it.each([
    'cat file | sh',
    'echo $(touch escaped)',
    'cat "$(touch escaped)"',
    'cat file\ntouch escaped',
    'sed -i backup file',
    'sed -i.bak file',
    'find . -exec touch escaped ;',
    'find . -delete',
    'rg --pre ./script pattern',
    'git checkout main',
    'pnpm test',
    './ls',
    '/workspace/git status',
    'git status --short',
    'cat .env',
    'cat secrets/private.pem',
    'head -c 100 /dev/zero',
    'find /',
  ])('does not classify %s as safe', command => {
    expect(isSafeShellCommand(command)).toBe(false);
  });
});

describe(FileShellPermissionStore, () => {
  describe('persistence', () => {
    it('round-trips a private policy and reports invalid or mismatched state', async () => {
      const directory = await temporaryDirectory();
      const store = new FileShellPermissionStore(directory);
      expect(await store.load('project')).toBeUndefined();
      const policy = {
        schemaVersion: 1 as const,
        projectContextId: 'project',
        mode: ShellPermissionMode.ASK,
        allowedCommands: ['pnpm test'],
      };

      await store.save(policy);

      await expect(store.load('project')).resolves.toEqual(policy);
      await expect(store.load('other')).rejects.toThrow('Could not load shell permissions');
      expect(JSON.parse(await readFile(join(directory, 'shell-permissions.json'), 'utf8'))).toEqual(policy);
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(directory, 'shell-permissions.json'))).mode & 0o777).toBe(0o600);
      }
    });
  });
});

function store(
  policy?: Awaited<ReturnType<ShellPermissionStore['load']>>,
  save: ShellPermissionStore['save'] = async () => {},
): ShellPermissionStore {
  return { load: async () => policy, save };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'glyph-shell-policy-'));
  temporaryDirectories.push(path);
  return path;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
