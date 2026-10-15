import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installShutdownHandlers } from '#src/terminal/installShutdownHandlers.js';
import { ShutdownSignal } from '#src/terminal/ShutdownSignal.js';
import type { GlyphService } from '#src/application/GlyphService.js';
import type { ChatSession } from '#src/chat/sessions/ChatSession.js';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { ShellWakeEvent } from '#src/shell/ShellWakeEvent.js';
import { TerminalApplication } from '#src/terminal/TerminalApplication.js';
import type { TerminalUI } from '#src/terminal/TerminalUI.js';
import { TerminalActionType } from '#src/terminal/TerminalActionType.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';

const projectContext = {
  id: 'project',
  mutationIdentity: 'project-root',
  kind: ProjectContextKind.FOLDER,
  name: 'Project',
  authority: 'local',
  roots: [{ name: 'Project', path: '/project' }],
};

describe(TerminalApplication, () => {
  it('synchronizes the global trace setting when activating a cached chat', () => {
    const cached = chat('cached');
    const setTraceEnabled = vi.fn();
    cached.session.setTraceEnabled = setTraceEnabled;
    const app = new TerminalApplication(
      { isTraceEnabled: false } as GlyphService,
      { showChatActivated: vi.fn() } as unknown as TerminalUI,
      new AbortController().signal,
      { projectContext },
    );
    (app as unknown as { activateChat(chat: ChatSession): void }).activateChat(cached.session);
    expect(setTraceEnabled).toHaveBeenCalledWith(false);
  });

  it('leaves another account wake queued until that account becomes active', async () => {
    const wake = wakeEvent({ ownerChatId: 'account-a-chat' });
    const queue = [wake];
    const shell = {
      takePendingWake: () => queue.shift(),
      peekPendingWake: (accepts: (event: ShellWakeEvent) => boolean) => queue.find(accepts),
      onDidWake: () => () => {},
    } as unknown as ShellSessionManager;
    const glyph = {
      listChats: (account: { id: string }) => [{ id: `${account.id}-chat` }],
    } as unknown as GlyphService;
    const ui = { nextAction: async () => ({ type: TerminalActionType.ACCOUNT }) } as unknown as TerminalUI;
    const app = new TerminalApplication(glyph, ui, new AbortController().signal, { projectContext }, undefined, shell);
    const next = app as unknown as { nextActivity(account: { provider: string; id: string }): Promise<unknown> };
    expect(await next.nextActivity({ provider: 'fixture', id: 'account-b' })).toEqual({
      action: { type: TerminalActionType.ACCOUNT },
    });
    expect(queue).toEqual([wake]);
    expect(await next.nextActivity({ provider: 'fixture', id: 'account-a' })).toEqual({ wake });
    expect(queue).toEqual([wake]);
  });

  describe('background shell wake handling', () => {
    it.each(['wake persistence', 'request preparation', 'active inference'] as const)(
      'prevents uncancelled inference after shutdown during %s',
      async stage => {
        const owner = chat('owner');
        const shutdown = new AbortController();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
          release = resolve;
        });
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => {
          entered = resolve;
        });
        const pause = async () => {
          entered();
          await gate;
        };
        if (stage === 'wake persistence') owner.recordContext.mockImplementation(pause);
        let inferenceSignal: AbortSignal | undefined;
        owner.session.send = vi.fn(async (_request, _stream, signal) => {
          inferenceSignal = signal;
          if (stage === 'active inference') await pause();
          return { responseId: 'response', durationMs: 0, usage: null };
        });
        const glyph = {
          resolveChatRequest: async (text: string) => {
            if (stage === 'request preparation') await pause();
            return { text, attachments: [] };
          },
          commitReviewResults: vi.fn(async () => {}),
          redact: (value: string) => value,
        } as unknown as GlyphService;
        const ui = {
          showShellWake: vi.fn(),
          beginAssistantResponse: vi.fn(),
          showTurnCompleted: vi.fn(),
          showTurnFailed: vi.fn(),
          close: vi.fn(),
        } as unknown as TerminalUI;
        const application = new TerminalApplication(glyph, ui, shutdown.signal, { projectContext });
        setConversation(application, owner.session);
        const signals = new EventEmitter();
        const stop = installShutdownHandlers(
          {
            active: () => application.active,
            shutdown: () => {
              shutdown.abort();
              ui.close();
            },
          },
          signals,
        );
        const resumed = resumeFromWake(application, wakeEvent());
        try {
          await waiting;
          if (stage === 'active inference') {
            // Input closure can abort the application without the SIGINT handler.
            shutdown.abort();
          } else {
            signals.emit(ShutdownSignal.SIGINT);
            if (!shutdown.signal.aborted) signals.emit(ShutdownSignal.SIGINT);
          }
          expect(shutdown.signal.aborted).toBe(true);
          release();
          await resumed;
          if (stage === 'active inference') expect(inferenceSignal?.aborted).toBe(true);
          else expect(owner.session.send).not.toHaveBeenCalled();
          expect(ui.showTurnCompleted).not.toHaveBeenCalled();
          expect(ui.showTurnFailed).not.toHaveBeenCalled();
        } finally {
          release();
          stop();
          await resumed;
        }
      },
    );

    it('returns an already queued wake before opening the prompt', async () => {
      const wake = wakeEvent();
      const nextAction = vi.fn();
      const application = createApplication(
        { nextAction } as unknown as TerminalUI,
        { peekPendingWake: vi.fn(() => wake) } as unknown as ShellSessionManager,
      );

      await expect(nextActivity(application)).resolves.toEqual({ wake });
      expect(nextAction).not.toHaveBeenCalled();
    });

    it('cancels the open prompt without consuming a wake before its durable delivery', async () => {
      const wake = wakeEvent();
      let listener: ((event: ShellWakeEvent) => void) | undefined;
      const stop = vi.fn();
      const takePendingWake = vi.fn(() => undefined as ShellWakeEvent | undefined);
      const shellSessions = {
        peekPendingWake: () => undefined,
        takePendingWake,
        onDidWake: vi.fn((value: (event: ShellWakeEvent) => void) => {
          listener = value;
          return stop;
        }),
      } as unknown as ShellSessionManager;
      const nextAction = vi.fn(
        (_signal: AbortSignal) =>
          new Promise((_, reject) => {
            _signal.addEventListener('abort', () => reject(_signal.reason), { once: true });
            setImmediate(() => listener?.(wake));
          }),
      );
      const preservePromptDraft = vi.fn();
      const application = createApplication(
        { nextAction, preservePromptDraft } as unknown as TerminalUI,
        shellSessions,
      );

      await expect(nextActivity(application)).resolves.toEqual({ wake });
      expect(takePendingWake).not.toHaveBeenCalled();
      expect(preservePromptDraft).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    });

    it('returns the normal terminal action when no shell manager is configured', async () => {
      const action = { type: TerminalActionType.HELP } as const;
      const nextAction = vi.fn(async () => action);
      const application = createApplication({ nextAction } as unknown as TerminalUI);

      await expect(nextActivity(application)).resolves.toEqual({ action });
    });

    it('records a wake in its owning chat then restores the chat that owns the unfinished prompt', async () => {
      const wake = wakeEvent({ ownerChatId: 'owner-chat' });
      const owner = chat('owner-chat');
      const current = chat('current-chat');
      const resolveChatRequest = vi.fn(async (text: string) => ({ text, attachments: [] }));
      const openChat = vi.fn(() => owner.session);
      const commitReviewResults = vi.fn(async () => {});
      const glyph = {
        proposalReviews: undefined,
        resolveChatRequest,
        openChat,
        commitReviewResults,
        redact: (value: string) => value,
      } as unknown as GlyphService;
      const showShellWake = vi.fn();
      const ui = {
        showChatActivated: vi.fn(),
        showShellWake,
        beginAssistantResponse: vi.fn(),
        showTurnCompleted: vi.fn(),
        showTurnFailed: vi.fn(),
      } as unknown as TerminalUI;
      const setOwnerChat = vi.fn();
      const application = new TerminalApplication(
        glyph,
        ui,
        new AbortController().signal,
        { projectContext },
        undefined,
        { setOwnerChat, takePendingWake: vi.fn() } as unknown as ShellSessionManager,
      );
      setConversation(application, current.session);

      await resumeFromWake(application, wake);

      expect(openChat).toHaveBeenCalledWith('owner-chat', expect.objectContaining({ id: 'account' }));
      expect(owner.recordContext).toHaveBeenCalledWith([
        { schemaVersion: 1, id: wake.id, type: 'shell_wake', payload: wake },
      ]);
      expect(showShellWake).toHaveBeenCalledWith(wake);
      expect(setOwnerChat).toHaveBeenCalledWith('owner-chat');
      expect(owner.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('shell_wake') }),
        ui,
        expect.any(AbortSignal),
      );
      expect(commitReviewResults).toHaveBeenCalledWith(owner.session);
      // A wake must not transfer the preserved prompt into its owning chat.
      expect(ui.showChatActivated).toHaveBeenLastCalledWith(current.session.summary, current.session.transcript);
      expect(setOwnerChat).toHaveBeenLastCalledWith('current-chat');
    });
  });
});

function createApplication(ui: TerminalUI, shellSessions?: ShellSessionManager): TerminalApplication {
  return new TerminalApplication(
    { proposalReviews: undefined } as unknown as GlyphService,
    ui,
    new AbortController().signal,
    { projectContext },
    undefined,
    shellSessions,
  );
}

function nextActivity(application: TerminalApplication): Promise<unknown> {
  return (
    application as unknown as {
      nextActivity(): Promise<unknown>;
    }
  ).nextActivity();
}

function resumeFromWake(application: TerminalApplication, wake: ShellWakeEvent): Promise<void> {
  return (
    application as unknown as {
      resumeFromShellWake(event: ShellWakeEvent, account: { provider: string; id: string }): Promise<void>;
    }
  ).resumeFromShellWake(wake, { provider: 'fixture', id: 'account' });
}

function setConversation(application: TerminalApplication, conversation: ChatSession): void {
  (application as unknown as { conversation: ChatSession }).conversation = conversation;
}

function chat(id: string) {
  const recordContext = vi.fn(async () => {});
  const send = vi.fn(async () => ({ responseId: 'response', durationMs: 10, usage: null }));
  const session = {
    id,
    summary: {
      schemaVersion: 3,
      id,
      title: 'Chat',
      titleOrigin: 'generated',
      projectContextId: 'project',
      accountProvider: 'fixture',
      accountId: 'account',
      modelSlug: 'model',
      modelName: 'Model',
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z',
      turnCount: 0,
    },
    transcript: [],
    recordContext,
    setTraceEnabled: vi.fn(),
    send,
  } as unknown as ChatSession;
  return { session, recordContext, send };
}

function wakeEvent(overrides: Partial<ShellWakeEvent> = {}): ShellWakeEvent {
  return {
    id: 'wake-one',
    terminalId: 'terminal-one',
    pattern: 'ready',
    command: 'pnpm dev',
    workingDirectory: '/project',
    output: 'ready',
    matchedAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}
