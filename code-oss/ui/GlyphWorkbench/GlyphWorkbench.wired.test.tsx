import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphChatSummary } from '#src/desktop/tests/fixtures/aGlyphChatSummary.ts';
import { aGlyphRunProjection } from '#src/desktop/tests/fixtures/aGlyphRunProjection.ts';
import { aGlyphWorkbenchState } from '#src/desktop/tests/fixtures/aGlyphWorkbenchState.ts';
import { WiredGlyphWorkbench } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.wired.tsx';

afterEach(cleanup);

const workbench = (overrides: Parameters<typeof aGlyphWorkbenchState>[0] = {}) =>
  aGlyphWorkbenchState({ models: [{ slug: 'gpt-5', name: 'GPT-5' }], ...overrides });
const chat = (overrides: Parameters<typeof aGlyphChatSummary>[0] = {}) =>
  aGlyphChatSummary({ title: 'Refactor parser', updatedAt: new Date().toISOString(), ...overrides });
const run = aGlyphRunProjection;

const workbenchActions = (overrides: Partial<GlyphWorkbenchViewActions> = {}): GlyphWorkbenchViewActions =>
  ({
    composer: new GlyphComposerState(),
    context: {
      selectFiles: vi.fn(async () => []),
      searchFiles: vi.fn(async () => []),
      captureFile: vi.fn(),
      openAttachment: vi.fn(async () => {}),
      refreshAttachment: vi.fn(),
      checkAttachment: vi.fn(async () => undefined),
    },
    send: vi.fn(async () => {}),
    cancel: vi.fn(),
    newChat: vi.fn(),
    openChat: vi.fn(async () => {}),
    selectModel: vi.fn(async () => {}),
    selectAccount: vi.fn(async () => {}),
    stopShell: vi.fn(async () => {}),
    writeShellInput: vi.fn(async () => {}),
    decideApproval: vi.fn(async () => {}),
    answerQuestion: vi.fn(async () => {}),
    reviewProposalFile: vi.fn(async () => {}),
    decideProposalItems: vi.fn(async () => {}),
    ...overrides,
  }) as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;

describe(WiredGlyphWorkbench, () => {
  it.each(['available', 'missing-chat', 'missing-plan', 'no-plans'])(
    'opens a build order only when its source plan is available: %s',
    async availability => {
      const sourcePlan = {
        id: 'plan',
        revision: 1,
        title: 'Build work',
        summary: '',
        markdown: '',
        todos: [],
        agents: [],
      };
      const viewPlan = vi.fn(async () => {
        throw new Error('Editor unavailable');
      });
      const state = workbench({
        selectedChatId: 'chat',
        buildingPlanIds: ['plan'],
        chats: [
          chat({
            id: 'chat',
            ...(availability === 'no-plans'
              ? {}
              : { plans: [{ ...sourcePlan, id: availability === 'missing-plan' ? 'other' : 'plan' }] }),
          }),
        ],
        transcript: [
          {
            id: 'build',
            role: GlyphTranscriptRole.USER,
            text: 'Build order',
            options: {
              planBuild: {
                planId: 'plan',
                revision: 1,
                title: 'Build work',
                sourceChatId: availability === 'missing-chat' ? 'gone' : 'chat',
                todos: [],
              },
            },
          },
        ],
      });
      render(<WiredGlyphWorkbench state={state} actions={workbenchActions({ viewPlan })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Build Build work. Open plan' }));
      if (availability === 'available') {
        await waitFor(() => {
          expect(viewPlan).toHaveBeenCalledWith('chat', sourcePlan);
        });
      } else expect(viewPlan).not.toHaveBeenCalled();
    },
  );
  it('shows a new chat draft with a composer and model picker', () => {
    render(<WiredGlyphWorkbench state={workbench()} actions={workbenchActions()} />);

    expect(screen.getByRole('tab', { name: 'New chat' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('log', { name: 'Glyph conversation' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Message Glyph' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Conversation token usage' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Questions' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pending reviews' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'To-dos' })).toBeNull();
  });

  it('shows the selected chat with its plans, usage, reviews, todos and background terminals', () => {
    const state = workbench({
      chats: [
        chat({
          todos: [{ id: 'todo', text: 'Ship', status: 'pending' }],
          plans: [
            { id: 'plan', revision: 1, title: 'Ship it', summary: 'Summary', markdown: '', todos: [], agents: [] },
          ],
        }),
      ],
      selectedChatId: 'chat',
      openChatIds: ['chat'],
      transcript: [],
      proposals: [
        {
          id: 'proposal',
          chatId: 'chat',
          createdAt: '2026-01-01T00:00:00.000Z',
          files: [
            {
              id: 'file',
              path: 'a.ts',
              proposedUri: 'glyph://a',
              pendingItemIds: ['item'],
              textOnly: true,
              applicability: GlyphProposalApplicability.READY,
            },
          ],
        },
      ],
      shells: [
        { id: 'mine', chatId: 'chat', command: 'npm run dev', workingDirectory: '/', output: '', running: true },
        { id: 'theirs', chatId: 'other', command: 'make', workingDirectory: '/', output: '', running: true },
      ],
    });
    render(<WiredGlyphWorkbench state={state} actions={workbenchActions()} />);

    expect(screen.getByRole('tab', { name: 'Refactor parser' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Plan: Ship it' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Conversation token usage' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Pending reviews' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'To-dos' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 background terminal' })).toBeTruthy();
  });

  it('opens and stops background terminals through the host', async () => {
    const openShell = vi.fn(async () => {});
    const actions = workbenchActions({ openShell });
    const state = workbench({
      selectedChatId: 'chat',
      shells: [
        { id: 'mine', chatId: 'chat', command: 'npm run dev', workingDirectory: '/', output: '', running: true },
      ],
    });
    render(<WiredGlyphWorkbench state={state} actions={actions} />);

    fireEvent.click(screen.getByRole('button', { name: '1 background terminal' }));
    fireEvent.click(screen.getByTitle('Open terminal: npm run dev'));
    await waitFor(() => {
      expect(openShell).toHaveBeenCalledWith('chat', 'mine');
    });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop' }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(actions.stopShell).toHaveBeenCalledWith('chat', 'mine');
    });
  });

  it('reports that terminals cannot be opened without a terminal viewer', async () => {
    const state = workbench({
      selectedChatId: 'chat',
      shells: [
        { id: 'mine', chatId: 'chat', command: 'npm run dev', workingDirectory: '/', output: '', running: true },
      ],
    });
    render(<WiredGlyphWorkbench state={state} actions={workbenchActions()} />);

    fireEvent.click(screen.getByRole('button', { name: '1 background terminal' }));
    fireEvent.click(screen.getByTitle('Open terminal: npm run dev'));

    expect((await screen.findByRole('alert')).textContent).toBe('Terminal viewer unavailable.');
  });

  it('asks the pending question of the selected chat and keeps its draft across updates', () => {
    const question = { id: 'ask', title: 'Question', prompt: 'Why?' };
    const state = workbench({
      selectedChatId: 'chat',
      runs: [run({ status: GlyphRunStatus.WAITING_FOR_QUESTION, question })],
    });
    const actions = workbenchActions();
    const { rerender } = render(<WiredGlyphWorkbench state={state} actions={actions} />);

    fireEvent.input(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Because' } });
    rerender(<WiredGlyphWorkbench state={{ ...state, sequence: 1 }} actions={actions} />);

    expect(screen.getByRole('form', { name: 'Questions' })).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your answer' }).value).toBe('Because');
  });

  it('shows workspace messages and retries reconnecting through the host', async () => {
    const reconnectWorkspace = vi.fn(async () => {
      throw new Error('Still offline');
    });
    render(
      <WiredGlyphWorkbench
        state={workbench({ workspaceMessage: 'Workspace disconnected', workspaceRetryable: true })}
        actions={workbenchActions({ reconnectWorkspace })}
      />,
    );

    expect(screen.getByText('Workspace disconnected')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });

    expect(reconnectWorkspace).toHaveBeenCalledOnce();
  });

  it('offers no retry when the host cannot reconnect', () => {
    render(
      <WiredGlyphWorkbench
        state={workbench({ workspaceMessage: 'Workspace disconnected', workspaceRetryable: true })}
        actions={workbenchActions()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it.each([
    ['the window is read-only', { readOnly: true }],
    ['navigation is pending', { navigationPending: true }],
    ['a new chat waits for the model catalog', { catalogPending: true }],
  ])('disables the composer while %s', (_, overrides) => {
    render(<WiredGlyphWorkbench state={workbench(overrides)} actions={workbenchActions()} />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Attach file' }).disabled).toBe(true);
  });

  it('keeps the composer of an existing chat available while the catalog loads', () => {
    render(
      <WiredGlyphWorkbench
        state={workbench({ catalogPending: true, selectedChatId: 'chat', chats: [chat()] })}
        actions={workbenchActions()}
      />,
    );

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Attach file' }).disabled).toBe(false);
  });

  it('opens chat history beside the conversation and closes it again', async () => {
    render(<WiredGlyphWorkbench state={workbench({ chats: [chat()] })} actions={workbenchActions()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));

    expect(screen.getByRole('navigation', { name: 'Saved chats' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Recent chats' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search chats' }), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Saved chats' })).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Chat history' }));
  });

  it('shows a pending approval of the selected chat on its reply', () => {
    const state = workbench({
      selectedChatId: 'chat',
      transcript: [{ id: 'run', role: GlyphTranscriptRole.ASSISTANT, text: 'Need to run a command' }],
      runs: [
        run({
          status: GlyphRunStatus.WAITING_FOR_APPROVAL,
          approval: {
            id: 'approval',
            title: 'Run command',
            detail: 'Clean the build output',
            sandboxed: true,
            command: 'rm -rf build',
          },
        }),
      ],
    });
    render(<WiredGlyphWorkbench state={state} actions={workbenchActions()} />);

    expect(screen.getAllByText(/rm -rf build/u).length).toBeGreaterThan(0);
  });
});
