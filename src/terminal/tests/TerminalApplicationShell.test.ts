import { describe, expect, it, vi } from 'vitest';
import type { GlyphService } from '../../application/GlyphService.ts';
import type { ChatSession } from '../../chat/sessions/ChatSession.ts';
import type { ShellSessionManager } from '../../shell/ShellSessionManager.ts';
import type { ShellWakeEvent } from '../../shell/ShellWakeEvent.ts';
import { TerminalApplication } from '../TerminalApplication.ts';
import type { TerminalUI } from '../TerminalUI.tsx';
import { TerminalActionType } from '../TerminalActionType.ts';
import { ProjectContextKind } from '../../project/context/ProjectContextKind.ts';

const projectContext = {
  id: 'project',
  mutationIdentity: 'project-root',
  kind: ProjectContextKind.FOLDER,
  name: 'Project',
  authority: 'local',
  roots: [{ name: 'Project', path: '/project' }],
};

describe(TerminalApplication, () => {
  describe('background shell wake handling', () => {
    it('returns an already queued wake before opening the prompt', async () => {
      const wake = wakeEvent();
      const nextAction = vi.fn();
      const application = createApplication(
        { nextAction } as unknown as TerminalUI,
        { takePendingWake: vi.fn(() => wake) } as unknown as ShellSessionManager,
      );

      await expect(nextActivity(application)).resolves.toEqual({ wake });
      expect(nextAction).not.toHaveBeenCalled();
    });

    it('cancels the open prompt and consumes a newly emitted wake exactly once', async () => {
      const wake = wakeEvent();
      let listener: ((event: ShellWakeEvent) => void) | undefined;
      const stop = vi.fn();
      const takePendingWake = vi.fn(() => undefined as ShellWakeEvent | undefined);
      const shellSessions = {
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
      expect(takePendingWake).toHaveBeenLastCalledWith(wake.id);
      expect(preservePromptDraft).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    });

    it('returns the normal terminal action when no shell manager is configured', async () => {
      const action = { type: TerminalActionType.HELP } as const;
      const nextAction = vi.fn(async () => action);
      const application = createApplication({ nextAction } as unknown as TerminalUI);

      await expect(nextActivity(application)).resolves.toEqual({ action });
    });

    it('records durable context and resumes the owning chat as an autonomous turn', async () => {
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
        { setOwnerChat } as unknown as ShellSessionManager,
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
