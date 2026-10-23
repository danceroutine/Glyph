import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { NativeShellSandboxLauncher } from '#src/shell/NativeShellSandboxLauncher.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkspaceRoot } from '#src/desktop/protocol/connection/GlyphWorkspaceRoot.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type {
  GlyphDesktopWorkspaceRuntime,
  GlyphRuntimeCommand,
  GlyphRuntimeSnapshot,
} from './GlyphDesktopWorkspaceRuntime.ts';
import type { GlyphDesktopWorkspaceRuntimeFactory } from './GlyphDesktopWorkspaceRuntimeFactory.ts';

/**
 * Exercises packaged native dependencies and process transport in explicitly
 * selected integration tests. Normal desktop launches use OpenAIDesktopRuntimeFactory.
 */
export class DeterministicDesktopRuntimeFactory implements GlyphDesktopWorkspaceRuntimeFactory {
  private probe: Promise<void> | undefined;

  async create(input: {
    readonly identity: GlyphConnectionIdentity;
    readonly roots: readonly GlyphWorkspaceRoot[];
    readonly emit: (event: GlyphHostEvent) => void;
  }): Promise<GlyphDesktopWorkspaceRuntime> {
    const root = input.roots[0]?.canonicalPath;
    if (root === undefined || root === '') throw new Error('The native Glyph runtime requires a local workspace root.');
    await (this.probe ??= probePackagedRuntime(root));
    return new DeterministicDesktopRuntime(input.emit);
  }
}

class DeterministicDesktopRuntime implements GlyphDesktopWorkspaceRuntime {
  private readonly runs = new Map<string, GlyphRunProjection>();
  private readonly cancellations = new Set<string>();

  constructor(private readonly emit: (event: GlyphHostEvent) => void) {}

  snapshot(): Promise<GlyphRuntimeSnapshot> {
    return Promise.resolve({
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
          updatedAt: new Date(0).toISOString(),
          turnCount: 0,
        },
      ],
      runs: [...this.runs.values()],
      proposals: [],
    });
  }

  async handle(command: GlyphRuntimeCommand): Promise<void> {
    if (command.type === GlyphWorkbenchCommandType.SEND) {
      void this.send(command);
      return;
    }
    if (command.type === GlyphWorkbenchCommandType.CANCEL_RUN) {
      this.cancellations.add(command.runId);
    }
  }

  connectionLost(): Promise<void> {
    for (const runId of this.runs.keys()) this.cancellations.add(runId);
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    for (const runId of this.runs.keys()) this.cancellations.add(runId);
    return Promise.resolve();
  }

  private async send(command: Extract<GlyphRuntimeCommand, { type: GlyphWorkbenchCommandType.SEND }>): Promise<void> {
    const { chatId, runId } = command;
    const attachmentCharacters = command.attachments.reduce((sum, item) => sum + item.text.length, 0);
    let text = '';
    const initial: GlyphRunProjection = {
      chatId,
      runId,
      userText: command.text,
      status: GlyphRunStatus.STREAMING,
      text,
      reasoning: '',
      tools: [],
    };
    this.runs.set(runId, initial);
    this.emit({ type: GlyphHostEventType.RUN_STATE, run: initial });
    const response =
      attachmentCharacters > 0
        ? `The packaged Glyph host received ${attachmentCharacters} characters from the live editor selection.`
        : 'The packaged Glyph host is connected through the native utility-process transport.';
    for (const part of response.split(/(?<=\s)/u)) {
      // A test-selected delay makes partial responses and cancellation observable
      // without coupling the black-box suite to the host's internal state.
      const configuredDelay = Number(process.env.GLYPH_DESKTOP_TEST_STREAM_DELAY_MS ?? 18);
      await delay(Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 18);
      if (this.cancellations.has(runId)) {
        const cancelled = {
          ...initial,
          status: GlyphRunStatus.CANCELLED,
          text,
          terminalMessage: 'Response cancelled.',
        };
        this.runs.set(runId, cancelled);
        this.emit({ type: GlyphHostEventType.RUN_STATE, run: cancelled });
        return;
      }
      text += part;
      this.emit({
        type: GlyphHostEventType.RESPONSE_DELTA,
        chatId,
        runId,
        delta: { kind: GlyphResponseDeltaKind.TEXT, value: part },
      });
    }
    const completed = { ...initial, status: GlyphRunStatus.COMPLETED, text };
    this.runs.set(runId, completed);
    this.emit({ type: GlyphHostEventType.RUN_STATE, run: completed });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(settle => {
    setTimeout(settle, milliseconds);
  });
}

async function probePackagedRuntime(workspaceRoot: string): Promise<void> {
  const database = new Database(':memory:');
  try {
    const result = database.prepare<[], { ok?: number }>('select 1 as ok').get();
    if (result?.ok !== 1) throw new Error('The packaged SQLite probe returned an invalid result.');
  } finally {
    database.close();
  }

  const artifactRoot = resolve(import.meta.dirname, '..', '..', '..');
  const nativeRoot = join(artifactRoot, 'native', `${process.platform}-${process.arch}`);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  await execute(join(nativeRoot, `glyph-context-index${suffix}`), ['--help']);

  const stateDirectory = await mkdtemp(join(tmpdir(), 'glyph-desktop-probe-'));
  try {
    const child = new NativeShellSandboxLauncher({
      binaryPath: join(nativeRoot, `glyph-shell-sandbox${suffix}`),
      workspaceRoots: [workspaceRoot],
      stateDirectory,
      protectedPaths: [artifactRoot],
    }).launch('true', workspaceRoot, { sandboxProfile: ShellSandboxProfile.READ_ONLY });
    child.stdin?.end();
    await childResult(child);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

function execute(file: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(file, arguments_, (error: Error | null) => {
      if (error) reject(error);
      else resolvePromise();
    });
    child.stdin?.end();
  });
}

function childResult(child: ReturnType<NativeShellSandboxLauncher['launch']>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(new Error(`The packaged shell sandbox probe failed (${signal ?? code ?? 'unknown'}): ${stderr.trim()}`));
    });
  });
}
