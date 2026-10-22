import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DeterministicDesktopRuntimeFactory } from '#src/desktop/host/DeterministicDesktopRuntime.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';

const native = vi.hoisted(() => ({
  probeResult: vi.fn<() => { ok?: number }>(),
  close: vi.fn(),
  execFile: vi.fn(),
  launcher: vi.fn(),
  launch: vi.fn(),
}));

vi.mock('better-sqlite3', () => ({
  default: class {
    prepare() {
      return { get: () => native.probeResult() };
    }
    close() {
      native.close();
    }
  },
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: native.execFile,
}));

vi.mock('#src/shell/NativeShellSandboxLauncher.js', () => ({
  NativeShellSandboxLauncher: class {
    constructor(options: unknown) {
      native.launcher(options);
    }
    launch(...arguments_: unknown[]): unknown {
      return native.launch(...arguments_);
    }
  },
}));

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const nativeRoot = join(repositoryRoot, 'native', `${process.platform}-${process.arch}`);
const suffix = process.platform === 'win32' ? '.exe' : '';

function sandboxChild(exit: { code: number | null; signal: string | null; stderr?: string }) {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    stdin: {
      end: () => {
        queueMicrotask(() => {
          if (exit.stderr !== undefined && exit.stderr !== '') child.stderr.emit('data', Buffer.from(exit.stderr));
          child.emit('exit', exit.code, exit.signal);
        });
      },
    },
  });
  return child;
}

function passingProbe() {
  native.probeResult.mockReset().mockReturnValue({ ok: 1 });
  native.close.mockReset();
  native.launcher.mockReset();
  native.execFile
    .mockReset()
    .mockImplementation((_file: string, _arguments: string[], callback: (error: Error | null) => void) => {
      queueMicrotask(() => {
        callback(null);
      });
      return { stdin: { end: vi.fn() } };
    });
  native.launch.mockReset().mockImplementation(() => sandboxChild({ code: 0, signal: null }));
}

const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }];
const identity = { profileId: 'profile', windowId: 'window', workspaceId: 'workspace' };

async function createRuntime(emit: (event: GlyphHostEvent) => void) {
  passingProbe();
  return new DeterministicDesktopRuntimeFactory().create({ identity, roots, emit });
}

describe(DeterministicDesktopRuntimeFactory, () => {
  describe(DeterministicDesktopRuntimeFactory.prototype.create, () => {
    it('requires a local workspace root', async () => {
      passingProbe();
      await expect(
        new DeterministicDesktopRuntimeFactory().create({ identity, roots: [], emit: vi.fn() }),
      ).rejects.toThrow('The native Glyph runtime requires a local workspace root.');
      expect(native.execFile).not.toHaveBeenCalled();
    });

    it('probes the packaged native dependencies once per factory', async () => {
      passingProbe();
      const factory = new DeterministicDesktopRuntimeFactory();
      await factory.create({ identity, roots, emit: vi.fn() });
      await factory.create({ identity, roots, emit: vi.fn() });
      expect(native.close).toHaveBeenCalledOnce();
      expect(native.execFile).toHaveBeenCalledOnce();
      expect(native.execFile).toHaveBeenCalledWith(
        join(nativeRoot, `glyph-context-index${suffix}`),
        ['--help'],
        expect.any(Function),
      );
      expect(native.launcher).toHaveBeenCalledExactlyOnceWith({
        binaryPath: join(nativeRoot, `glyph-shell-sandbox${suffix}`),
        workspaceRoots: ['/project'],
        stateDirectory: expect.stringContaining('glyph-desktop-probe-'),
        protectedPaths: [repositoryRoot],
      });
      expect(native.launch).toHaveBeenCalledExactlyOnceWith('true', '/project', {
        sandboxProfile: ShellSandboxProfile.READ_ONLY,
      });
      const [{ stateDirectory }] = native.launcher.mock.calls[0] as [{ stateDirectory: string }];
      expect(existsSync(stateDirectory)).toBe(false);
    });

    it('probes Windows executables by their packaged names', async () => {
      passingProbe();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', platform);
      });
      await new DeterministicDesktopRuntimeFactory().create({ identity, roots, emit: vi.fn() });
      const windowsRoot = join(repositoryRoot, 'native', `win32-${process.arch}`);
      expect(native.execFile).toHaveBeenCalledWith(
        join(windowsRoot, 'glyph-context-index.exe'),
        ['--help'],
        expect.any(Function),
      );
      expect(native.launcher).toHaveBeenCalledWith(
        expect.objectContaining({ binaryPath: join(windowsRoot, 'glyph-shell-sandbox.exe') }),
      );
    });

    it('rejects an invalid SQLite probe result after closing the database', async () => {
      passingProbe();
      native.probeResult.mockReturnValue({});
      await expect(new DeterministicDesktopRuntimeFactory().create({ identity, roots, emit: vi.fn() })).rejects.toThrow(
        'The packaged SQLite probe returned an invalid result.',
      );
      expect(native.close).toHaveBeenCalledOnce();
      expect(native.execFile).not.toHaveBeenCalled();
    });

    it('keeps reporting a failed probe without probing again', async () => {
      passingProbe();
      native.execFile.mockImplementation((_file: string, _arguments: string[], callback: (error: Error) => void) => {
        queueMicrotask(() => {
          callback(new Error('missing context index'));
        });
        return { stdin: null };
      });
      const factory = new DeterministicDesktopRuntimeFactory();
      await expect(factory.create({ identity, roots, emit: vi.fn() })).rejects.toThrow('missing context index');
      await expect(factory.create({ identity, roots, emit: vi.fn() })).rejects.toThrow('missing context index');
      expect(native.execFile).toHaveBeenCalledOnce();
      expect(native.launch).not.toHaveBeenCalled();
    });

    it.each([
      { code: 1, signal: null, label: '1' },
      { code: null, signal: 'SIGKILL', label: 'SIGKILL' },
      { code: null, signal: null, label: 'unknown' },
    ])('reports a sandbox probe that exits with $label', async ({ code, signal, label }) => {
      passingProbe();
      native.launch.mockImplementation(() => sandboxChild({ code, signal, stderr: ' denied\n' }));
      await expect(new DeterministicDesktopRuntimeFactory().create({ identity, roots, emit: vi.fn() })).rejects.toThrow(
        `The packaged shell sandbox probe failed (${label}): denied`,
      );
      const [{ stateDirectory }] = native.launcher.mock.calls[0] as [{ stateDirectory: string }];
      expect(existsSync(stateDirectory)).toBe(false);
    });

    it('reports a sandbox probe that cannot start', async () => {
      passingProbe();
      native.launch.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), { stdin: null, stderr: null });
        queueMicrotask(() => {
          child.emit('error', new Error('spawn EACCES'));
        });
        return child;
      });
      await expect(new DeterministicDesktopRuntimeFactory().create({ identity, roots, emit: vi.fn() })).rejects.toThrow(
        'spawn EACCES',
      );
    });

    it('accepts a sandbox probe without standard streams', async () => {
      passingProbe();
      native.launch.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), { stdin: null, stderr: null });
        queueMicrotask(() => {
          child.emit('exit', 0, null);
        });
        return child;
      });
      await expect(
        new DeterministicDesktopRuntimeFactory().create({ identity, roots, emit: vi.fn() }),
      ).resolves.toBeDefined();
    });

    it('creates runtimes that expose the fixture catalog and their runs', async () => {
      const runtime = await createRuntime(vi.fn());
      await expect(runtime.snapshot()).resolves.toEqual({
        accounts: [
          { provider: 'fixture', id: 'native', label: 'Native integration', connected: true, inferenceAccess: true },
        ],
        models: [{ slug: 'fixture-native', name: 'Fixture native model' }],
        chats: [
          {
            id: 'native-chat',
            title: 'Native integration',
            accountProvider: 'fixture',
            accountId: 'native',
            modelSlug: 'fixture-native',
            updatedAt: '1970-01-01T00:00:00.000Z',
            turnCount: 0,
          },
        ],
        runs: [],
        proposals: [],
      });
    });

    it('creates runtimes that stream a fixed answer word by word at the default pace', async () => {
      const events: GlyphHostEvent[] = [];
      const runtime = await createRuntime(event => {
        events.push(event);
      });
      vi.useFakeTimers();
      vi.stubEnv('GLYPH_DESKTOP_TEST_STREAM_DELAY_MS', undefined);
      onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });
      const sent = runtime.handle(
        { type: GlyphWorkbenchCommandType.SEND, chatId: 'chat', runId: 'run', text: 'Hello', attachments: [] },
        { signal: new AbortController().signal, emit: vi.fn() },
      );
      await vi.advanceTimersByTimeAsync(17);
      expect(events).toEqual([
        {
          type: GlyphHostEventType.RUN_STATE,
          run: {
            chatId: 'chat',
            runId: 'run',
            userText: 'Hello',
            status: GlyphRunStatus.STREAMING,
            text: '',
            reasoning: '',
            tools: [],
          },
        },
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect(events[1]).toEqual({
        type: GlyphHostEventType.RESPONSE_DELTA,
        chatId: 'chat',
        runId: 'run',
        delta: { kind: GlyphResponseDeltaKind.TEXT, value: 'The ' },
      });
      await vi.runAllTimersAsync();
      await sent;
      const text = 'The packaged Glyph host is connected through the native utility-process transport.';
      expect(events.at(-1)).toEqual({
        type: GlyphHostEventType.RUN_STATE,
        run: {
          chatId: 'chat',
          runId: 'run',
          userText: 'Hello',
          status: GlyphRunStatus.COMPLETED,
          text,
          reasoning: '',
          tools: [],
        },
      });
      expect(events.filter(event => event.type === GlyphHostEventType.RESPONSE_DELTA)).toHaveLength(
        text.split(' ').length,
      );
      expect((await runtime.snapshot()).runs).toEqual([
        {
          chatId: 'chat',
          runId: 'run',
          userText: 'Hello',
          status: GlyphRunStatus.COMPLETED,
          text,
          reasoning: '',
          tools: [],
        },
      ]);
    });

    it.each(['not-a-number', '-1'])('creates runtimes that ignore the stream delay %j', async configured => {
      const events: GlyphHostEvent[] = [];
      const runtime = await createRuntime(event => {
        events.push(event);
      });
      vi.useFakeTimers();
      vi.stubEnv('GLYPH_DESKTOP_TEST_STREAM_DELAY_MS', configured);
      onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });
      const sent = runtime.handle(
        { type: GlyphWorkbenchCommandType.SEND, chatId: 'chat', runId: 'run', text: 'Hello', attachments: [] },
        { signal: new AbortController().signal, emit: vi.fn() },
      );
      await vi.advanceTimersByTimeAsync(17);
      expect(events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(events).toHaveLength(2);
      await vi.runAllTimersAsync();
      await sent;
    });

    it('creates runtimes that report how much attached context they received', async () => {
      const events: GlyphHostEvent[] = [];
      const runtime = await createRuntime(event => {
        events.push(event);
      });
      vi.useFakeTimers();
      vi.stubEnv('GLYPH_DESKTOP_TEST_STREAM_DELAY_MS', '0');
      onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });
      const attachment = {
        kind: GlyphContextAttachmentKind.SELECTION,
        uri: 'file:///project/a.ts',
        path: 'a.ts',
        contentRevision: 'r1',
      };
      const sent = runtime.handle(
        {
          type: GlyphWorkbenchCommandType.SEND,
          chatId: 'chat',
          runId: 'run',
          text: 'Explain',
          attachments: [
            { ...attachment, text: 'abc' },
            { ...attachment, text: 'de' },
          ],
        },
        { signal: new AbortController().signal, emit: vi.fn() },
      );
      await vi.runAllTimersAsync();
      await sent;
      expect(events.at(-1)).toMatchObject({
        type: GlyphHostEventType.RUN_STATE,
        run: {
          status: GlyphRunStatus.COMPLETED,
          text: 'The packaged Glyph host received 5 characters from the live editor selection.',
        },
      });
    });

    it('creates runtimes that accept a message while its answer is still streaming', async () => {
      const events: GlyphHostEvent[] = [];
      const runtime = await createRuntime(event => {
        events.push(event);
      });
      vi.useFakeTimers();
      vi.stubEnv('GLYPH_DESKTOP_TEST_STREAM_DELAY_MS', '10');
      onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });
      await runtime.handle(
        { type: GlyphWorkbenchCommandType.SEND, chatId: 'chat', runId: 'run', text: 'Hello', attachments: [] },
        { signal: new AbortController().signal, emit: vi.fn() },
      );
      expect(events).toEqual([
        expect.objectContaining({ run: expect.objectContaining({ status: GlyphRunStatus.STREAMING }) }),
      ]);
      await vi.runAllTimersAsync();
      expect(events.at(-1)).toEqual(
        expect.objectContaining({ run: expect.objectContaining({ status: GlyphRunStatus.COMPLETED }) }),
      );
    });

    it('creates runtimes that stop streaming with the partial answer when a run is cancelled', async () => {
      const events: GlyphHostEvent[] = [];
      const runtime = await createRuntime(event => {
        events.push(event);
      });
      vi.useFakeTimers();
      vi.stubEnv('GLYPH_DESKTOP_TEST_STREAM_DELAY_MS', '10');
      onTestFinished(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });
      const context = { signal: new AbortController().signal, emit: vi.fn() };
      const sent = runtime.handle(
        { type: GlyphWorkbenchCommandType.SEND, chatId: 'chat', runId: 'run', text: 'Hello', attachments: [] },
        context,
      );
      await vi.advanceTimersByTimeAsync(10);
      await runtime.handle({ type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: 'chat', runId: 'run' }, context);
      await vi.runAllTimersAsync();
      await sent;
      expect(events.at(-1)).toEqual({
        type: GlyphHostEventType.RUN_STATE,
        run: {
          chatId: 'chat',
          runId: 'run',
          userText: 'Hello',
          status: GlyphRunStatus.CANCELLED,
          text: 'The ',
          reasoning: '',
          tools: [],
          terminalMessage: 'Response cancelled.',
        },
      });
    });

    it.each(['connectionLost', 'dispose'] as const)(
      'creates runtimes that cancel active runs on %s',
      async lifecycle => {
        const events: GlyphHostEvent[] = [];
        const runtime = await createRuntime(event => {
          events.push(event);
        });
        vi.useFakeTimers();
        vi.stubEnv('GLYPH_DESKTOP_TEST_STREAM_DELAY_MS', '10');
        onTestFinished(() => {
          vi.useRealTimers();
          vi.unstubAllEnvs();
        });
        const sent = runtime.handle(
          { type: GlyphWorkbenchCommandType.SEND, chatId: 'chat', runId: 'run', text: 'Hello', attachments: [] },
          { signal: new AbortController().signal, emit: vi.fn() },
        );
        await expect(
          lifecycle === 'dispose' ? runtime.dispose() : runtime.connectionLost('window'),
        ).resolves.toBeUndefined();
        await vi.runAllTimersAsync();
        await sent;
        expect(events.at(-1)).toMatchObject({
          type: GlyphHostEventType.RUN_STATE,
          run: { status: GlyphRunStatus.CANCELLED, text: '' },
        });
      },
    );

    it('creates runtimes that ignore commands they do not implement', async () => {
      const events: GlyphHostEvent[] = [];
      const runtime = await createRuntime(event => {
        events.push(event);
      });
      await expect(
        runtime.handle(
          { type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: 'native-chat' },
          { signal: new AbortController().signal, emit: vi.fn() },
        ),
      ).resolves.toBeUndefined();
      expect(events).toEqual([]);
    });
  });
});
