import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileShellPermissionStore } from '#src/shell/FileShellPermissionStore.js';
import { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import { ShellPermissionMode } from '#src/shell/ShellPermissionPolicy.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { isSafeShellCommand } from '#src/shell/isSafeShellCommand.js';
import type { ShellPermissionPresenter } from '#src/shell/ShellPermissionPresenter.js';
import type { ShellPermissionStore } from '#src/shell/ShellPermissionStore.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ShellCommandAuthorizer, () => {
  describe(ShellCommandAuthorizer.prototype.authorize, () => {
    it('cancels a queued chat shell command before another chat answers its approval', async () => {
      const events: GlyphHostEvent[] = [];
      const broker = new DesktopInteractionBroker(event => events.push(event));
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), broker);
      const launch = vi.fn(() => {
        throw new Error('No shell process should launch in this fixture.');
      });
      const manager = new ShellSessionManager(
        authorizer,
        { resolve: async () => '/project' } as ShellWorkingDirectoryResolver,
        { launch },
      );
      const firstController = new AbortController();
      const queuedController = new AbortController();
      const first = broker
        .run({ chatId: 'first', runId: 'first-run' }, () =>
          manager.execute('first command', { signal: firstController.signal, ownerChatId: 'first' }),
        )
        .catch(error => error);
      let queuedError: unknown;
      const queued = broker
        .run({ chatId: 'queued', runId: 'queued-run' }, () =>
          manager.execute('queued command', { signal: queuedController.signal, ownerChatId: 'queued' }),
        )
        .catch(error => {
          queuedError = error;
        });
      try {
        await flushQueue();
        expect(events).toHaveLength(1);
        const cancelled = new Error('Queued chat cancelled.');
        queuedController.abort(cancelled);
        await flushQueue();
        expect.soft(queuedError).toBe(cancelled);
        expect(firstController.signal.aborted).toBe(false);
        expect(events).toHaveLength(1);
        const approval = events[0];
        if (approval?.type !== GlyphHostEventType.APPROVAL) throw new Error('Expected the first chat approval.');
        broker.answer({
          chatId: 'first',
          runId: 'first-run',
          id: approval.approval.id,
          kind: 'approval',
          value: GlyphApprovalDecision.DENY,
        });
        expect(await first).toEqual(expect.objectContaining({ message: expect.stringContaining('denied') }));
        await queued;
        expect(events).toHaveLength(1);
        expect(manager.sessionsFor('queued')).toEqual([]);
        expect(launch).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
      } finally {
        firstController.abort();
        queuedController.abort();
        await Promise.all([first, queued]);
        await manager.dispose();
      }
    });

    it('cancels a queued caller without releasing a preceding policy save or reordering later authorization', async () => {
      let finishSave = () => {};
      const saveGate = new Promise<void>(resolve => {
        finishSave = resolve;
      });
      const save = vi.fn<ShellPermissionStore['save']>(() => saveGate);
      const presentShellPermission = vi.fn(async () => ShellPermissionDecision.ALLOW_EVERYTHING);
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), { presentShellPermission });
      const first = authorizer.authorize('first command', '/project', signal());
      const controller = new AbortController();
      let queuedError: unknown;
      const queued = authorizer.authorize('cancelled command', '/project', controller.signal).catch(error => {
        queuedError = error;
      });
      let followingSettled = false;
      const following = authorizer.authorize('following command', '/project', signal()).then(value => {
        followingSettled = true;
        return value;
      });
      try {
        await flushQueue();
        expect(save).toHaveBeenCalledOnce();
        const cancelled = new Error('Cancelled while queued behind persistence.');
        controller.abort(cancelled);
        await flushQueue();
        expect.soft(queuedError).toBe(cancelled);
        expect(followingSettled).toBe(false);
        expect(authorizer.mode).toBe(ShellPermissionMode.ASK);
        expect(presentShellPermission).toHaveBeenCalledOnce();
      } finally {
        finishSave();
        await Promise.all([first, queued, following]);
      }
      expect(authorizer.mode).toBe(ShellPermissionMode.ALLOW_EVERYTHING);
      expect(await following).toEqual({ sandboxProfile: ShellSandboxProfile.FULL_ACCESS });
      expect(presentShellPermission).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledOnce();
    });

    it.each([
      ShellPermissionDecision.ALLOW_ONCE,
      ShellPermissionDecision.ALWAYS_ALLOW,
      ShellPermissionDecision.ALLOW_SAFE,
      ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE,
      ShellPermissionDecision.ALLOW_EVERYTHING,
    ])('does not authorize or persist %s returned after its request is cancelled', async decision => {
      const controller = new AbortController();
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission: async () => {
          controller.abort(new Error('Permission cancelled.'));
          return decision;
        },
      });
      await expect(authorizer.authorize('echo test', '/project', controller.signal)).rejects.toThrow(
        'Permission cancelled.',
      );
      expect(save).not.toHaveBeenCalled();
      expect(authorizer.mode).toBe(ShellPermissionMode.ASK);
    });

    it('does not load or reuse saved full access for an already cancelled command', async () => {
      const load = vi.fn<ShellPermissionStore['load']>(async () => ({
        schemaVersion: 2,
        projectContextId: 'project',
        mode: ShellPermissionMode.ALLOW_EVERYTHING,
        allowedCommands: [],
      }));
      const presentShellPermission = vi.fn<ShellPermissionPresenter['presentShellPermission']>();
      const authorizer = new ShellCommandAuthorizer('project', { load, save: vi.fn() }, { presentShellPermission });
      await expect(
        authorizer.authorize('echo test', '/project', AbortSignal.abort(new Error('Already cancelled.'))),
      ).rejects.toThrow('Already cancelled.');
      expect(load).not.toHaveBeenCalled();
      expect(presentShellPermission).not.toHaveBeenCalled();
    });

    it('checks cancellation after policy loading before granting saved access', async () => {
      const controller = new AbortController();
      const authorizer = new ShellCommandAuthorizer(
        'project',
        {
          load: async () => {
            controller.abort(new Error('Cancelled while loading.'));
            return {
              schemaVersion: 2,
              projectContextId: 'project',
              mode: ShellPermissionMode.ALLOW_EVERYTHING,
              allowedCommands: [],
            };
          },
          save: vi.fn(),
        },
        { presentShellPermission: vi.fn() },
      );
      await expect(authorizer.authorize('echo test', '/project', controller.signal)).rejects.toThrow(
        'Cancelled while loading.',
      );
    });

    it('skips a cancelled queued command after another request grants full access', async () => {
      let resolveChoice: (decision: ShellPermissionDecision) => void = () => {};
      const choice = new Promise<ShellPermissionDecision>(resolve => {
        resolveChoice = resolve;
      });
      const presentShellPermission = vi.fn(() => choice);
      const save = vi.fn<ShellPermissionStore['save']>();
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), { presentShellPermission });
      const first = authorizer.authorize('echo first', '/project', signal());
      const controller = new AbortController();
      const queued = authorizer.authorize('echo second', '/project', controller.signal);
      const rejected = expect(queued).rejects.toThrow('Queued command cancelled.');
      controller.abort(new Error('Queued command cancelled.'));
      resolveChoice(ShellPermissionDecision.ALLOW_EVERYTHING);
      await first;
      await rejected;
      expect(presentShellPermission).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledOnce();
    });

    it('finishes an already dispatched policy save but does not authorize its cancelled command', async () => {
      const controller = new AbortController();
      const save = vi.fn<ShellPermissionStore['save']>(async () => {
        controller.abort(new Error('Cancelled while saving.'));
      });
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission: async () => ShellPermissionDecision.ALLOW_EVERYTHING,
      });
      await expect(authorizer.authorize('echo test', '/project', controller.signal)).rejects.toThrow(
        'Cancelled while saving.',
      );
      expect(save).toHaveBeenCalledOnce();
      expect(authorizer.mode).toBe(ShellPermissionMode.ALLOW_EVERYTHING);
    });

    it('asks again after workspace roots change without inheriting a previous scope grant', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-permission-scope-'));
      temporaryDirectories.push(directory);
      const permissions = new FileShellPermissionStore(directory);
      await permissions.save({
        schemaVersion: 2,
        projectContextId: 'old-roots',
        mode: ShellPermissionMode.ALLOW_EVERYTHING,
        allowedCommands: [],
      });
      const presentShellPermission = vi.fn<ShellPermissionPresenter['presentShellPermission']>(
        async () => ShellPermissionDecision.ALLOW_ONCE,
      );
      const authorizer = new ShellCommandAuthorizer('new-roots', permissions, { presentShellPermission });
      await authorizer.authorize('pnpm test', '/project', signal());
      await authorizer.authorize('pnpm test', '/project', signal());
      expect(presentShellPermission).toHaveBeenCalledTimes(2);
    });
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
        schemaVersion: 2,
        projectContextId: 'project',
        mode: ShellPermissionMode.ASK,
        allowedCommands: [{ command: 'pnpm test', workingDirectory: '/project' }],
      });
    });

    it('binds an exact-command grant to its reviewed working directory', async () => {
      const presentShellPermission = vi
        .fn<ShellPermissionPresenter['presentShellPermission']>()
        .mockResolvedValue(ShellPermissionDecision.ALWAYS_ALLOW);
      const authorizer = new ShellCommandAuthorizer('project', store(), { presentShellPermission });

      await authorizer.authorize('pnpm test', '/project/one', signal());
      await authorizer.authorize('pnpm test', '/project/one', signal());
      await authorizer.authorize('pnpm test', '/project/two', signal());

      expect(presentShellPermission).toHaveBeenCalledTimes(2);
      expect(presentShellPermission).toHaveBeenLastCalledWith(
        { command: 'pnpm test', workingDirectory: '/project/two' },
        expect.any(AbortSignal),
      );
    });

    it('does not retain a widened in-memory policy when persistence fails', async () => {
      const presentShellPermission = vi
        .fn<ShellPermissionPresenter['presentShellPermission']>()
        .mockResolvedValue(ShellPermissionDecision.ALWAYS_ALLOW);
      const save = vi.fn<ShellPermissionStore['save']>().mockRejectedValueOnce(new Error('save failed'));
      const authorizer = new ShellCommandAuthorizer('project', store(undefined, save), {
        presentShellPermission,
      });

      await expect(authorizer.authorize('pnpm test', '/project', signal())).rejects.toThrow('save failed');
      await authorizer.authorize('pnpm test', '/project', signal());

      expect(presentShellPermission).toHaveBeenCalledTimes(2);
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
        schemaVersion: 2,
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
          schemaVersion: 2,
          projectContextId: 'project',
          mode: ShellPermissionMode.ASK,
          allowedCommands: [{ command: 'pnpm test', workingDirectory: '/project' }],
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
  it.each(['cat .ENV', 'cat private.PEM', 'head config/.Env.production', 'cat .NETRC'])(
    'does not automatically approve a differently cased sensitive path in %s',
    command => {
      expect(isSafeShellCommand(command)).toBe(false);
    },
  );
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
    it('round-trips a private policy without granting its permissions to another mutation scope', async () => {
      const directory = await temporaryDirectory();
      const store = new FileShellPermissionStore(directory);
      expect(await store.load('project')).toBeUndefined();
      const policy = {
        schemaVersion: 2 as const,
        projectContextId: 'project',
        mode: ShellPermissionMode.ASK,
        allowedCommands: [{ command: 'pnpm test', workingDirectory: '/project' }],
      };

      await store.save(policy);

      await expect(store.load('project')).resolves.toEqual(policy);
      await expect(store.load('other')).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(join(directory, 'shell-permissions.json'), 'utf8'))).toEqual(policy);
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(directory, 'shell-permissions.json'))).mode & 0o777).toBe(0o600);
      }
    });

    it('migrates legacy exact-command grants closed because their directory scope is unknown', async () => {
      const directory = await temporaryDirectory();
      await new FileShellPermissionStore(directory).save({
        schemaVersion: 2,
        projectContextId: 'seed',
        mode: ShellPermissionMode.ASK,
        allowedCommands: [],
      });
      await writeFile(
        join(directory, 'shell-permissions.json'),
        JSON.stringify({
          schemaVersion: 1,
          projectContextId: 'project',
          mode: ShellPermissionMode.ASK,
          allowedCommands: ['pnpm test'],
        }),
      );

      await expect(new FileShellPermissionStore(directory).load('project')).resolves.toEqual({
        schemaVersion: 2,
        projectContextId: 'project',
        mode: ShellPermissionMode.ASK,
        allowedCommands: [],
      });
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

function flushQueue(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
