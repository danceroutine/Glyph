import { describe, expect, it } from 'vitest';
import { GlyphWorkbenchProjection } from '#src/desktop/workbench/GlyphWorkbenchProjection.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { AgentReviewScope, AgentReviewStatus } from '#src/reviewing/AgentReview.js';
import { AgentModeID } from '#src/chat/AgentMode.js';

describe(GlyphWorkbenchProjection, () => {
  it('interrupts pending human decisions on disconnect while preserving the partial answer', () => {
    const projection = new GlyphWorkbenchProjection();
    projection.accept({
      type: GlyphHostEventType.RESPONSE_DELTA,
      chatId: 'chat',
      runId: 'run',
      delta: { kind: GlyphResponseDeltaKind.TEXT, value: 'partial' },
    });
    projection.accept({
      type: GlyphHostEventType.QUESTION,
      chatId: 'chat',
      runId: 'run',
      question: { id: 'question', title: 'Choose', prompt: 'Which file?' },
    });
    projection.accept({
      type: GlyphHostEventType.HOST_STATUS,
      status: GlyphHostStatus.DISCONNECTED,
      message: 'Host exited',
    });
    expect(projection.state.runs[0]).toMatchObject({ status: GlyphRunStatus.INTERRUPTED, text: 'partial' });
    expect(projection.state.runs[0]?.question).toBeUndefined();
    expect(projection.diagnostics).toContain('Host exited');
  });

  it('restores pending decisions and replaces stale runs when a reconnect snapshot arrives', () => {
    const projection = new GlyphWorkbenchProjection();
    projection.accept({
      type: GlyphHostEventType.RESPONSE_DELTA,
      chatId: 'old',
      runId: 'old',
      delta: { kind: GlyphResponseDeltaKind.TEXT, value: 'stale' },
    });
    const question = { id: 'question', title: 'Choose', prompt: 'Which file?' };
    const approval = { id: 'approval', title: 'Allow?', detail: 'true', sandboxed: true };
    projection.accept({
      type: GlyphHostEventType.INITIAL_STATE,
      state: {
        accounts: [],
        models: [],
        chats: [],
        proposals: [],
        sequence: 9,
        ownerWindowId: 'owner',
        readOnly: true,
        runs: [
          {
            chatId: 'chat',
            runId: 'run',
            status: GlyphRunStatus.WAITING_FOR_QUESTION,
            text: 'answer',
            reasoning: 'thought',
            tools: [],
            question,
            approval,
          },
        ],
      },
    });
    expect(projection.state.runs).toHaveLength(1);
    expect(projection.state.runs[0]).toMatchObject({ text: 'answer', question, approval });
    expect(projection.state.readOnly).toBe(true);
    projection.accept({
      type: GlyphHostEventType.RUN_STATE,
      run: {
        chatId: 'chat',
        runId: 'run',
        status: GlyphRunStatus.COMPLETED,
        text: 'answer',
        reasoning: 'thought',
        tools: [],
      },
    });
    expect(projection.state.runs[0]?.question).toBeUndefined();
    expect(projection.state.runs[0]?.approval).toBeUndefined();
  });

  it('keeps streamed text, reasoning, and tool completion attached to their originating chats', () => {
    const projection = new GlyphWorkbenchProjection();
    for (const chatId of ['one', 'two'])
      projection.accept({
        type: GlyphHostEventType.RESPONSE_DELTA,
        chatId,
        runId: 'run',
        delta: { kind: GlyphResponseDeltaKind.TEXT, value: chatId },
      });
    projection.accept({
      type: GlyphHostEventType.RESPONSE_DELTA,
      chatId: 'one',
      runId: 'run',
      delta: { kind: GlyphResponseDeltaKind.REASONING, value: 'reasoning' },
    });
    for (const status of [GlyphToolActivityStatus.STARTED, GlyphToolActivityStatus.COMPLETED])
      projection.accept({
        type: GlyphHostEventType.TOOL_ACTIVITY,
        chatId: 'one',
        runId: 'run',
        activity: { id: 'tool', name: 'read', status },
      });
    expect(projection.state.runs.map(run => run.text)).toEqual(['one', 'two']);
    expect(projection.state.runs[0]?.tools).toEqual([
      { id: 'tool', name: 'read', status: GlyphToolActivityStatus.COMPLETED },
    ]);
    expect(projection.state.runs[1]?.reasoning).toBe('');
  });

  it('recovers usage from snapshots and keeps question and approval events actionable', () => {
    const projection = new GlyphWorkbenchProjection();
    const usage = { inputTokens: 2, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 5 };
    projection.accept({
      type: GlyphHostEventType.INITIAL_STATE,
      state: {
        accounts: [],
        models: [],
        chats: [],
        runs: [],
        proposals: [],
        ownerWindowId: 'owner',
        readOnly: false,
        sequence: 1,
        usageByChat: { chat: usage },
      },
    });
    projection.accept({
      type: GlyphHostEventType.QUESTION,
      chatId: 'chat',
      runId: 'run',
      question: { id: 'q', title: 'Question', prompt: 'Why?' },
    });
    expect(projection.state.runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_QUESTION);
    projection.accept({
      type: GlyphHostEventType.APPROVAL,
      chatId: 'chat',
      runId: 'run',
      approval: { id: 'a', title: 'Approve', detail: 'command', sandboxed: true },
    });
    expect(projection.state.runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
    expect(projection.usage.chat).toEqual(usage);
  });

  describe(GlyphWorkbenchProjection.prototype.accept, () => {
    it('adds new agent reviews and replaces updated ones', () => {
      const projection = new GlyphWorkbenchProjection();
      const review = {
        id: 'review',
        repositoryUri: 'file:///project',
        scope: AgentReviewScope.STAGED,
        branch: '',
        label: 'Staged changes',
        files: [],
        accountProvider: 'openai',
        accountId: 'account',
        model: 'model',
        status: AgentReviewStatus.RUNNING,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        findings: [],
        dismissedIds: [],
        summary: '',
      };
      projection.accept({ type: GlyphHostEventType.AGENT_REVIEW_CHANGED, review });
      projection.accept({
        type: GlyphHostEventType.AGENT_REVIEW_CHANGED,
        review: { ...review, id: 'other' },
      });
      projection.accept({
        type: GlyphHostEventType.AGENT_REVIEW_CHANGED,
        review: { ...review, status: AgentReviewStatus.COMPLETED },
      });
      expect(projection.state.agentReviews?.map(value => [value.id, value.status])).toEqual([
        ['review', AgentReviewStatus.COMPLETED],
        ['other', AgentReviewStatus.RUNNING],
      ]);
    });

    it('replaces the background shell list', () => {
      const projection = new GlyphWorkbenchProjection();
      const shells = [
        { id: 'shell', chatId: 'chat', command: 'npm test', workingDirectory: '/project', output: '', running: true },
      ];
      projection.accept({ type: GlyphHostEventType.SHELL_SESSIONS, shells });
      expect(projection.state.shells).toEqual(shells);
    });

    it('adds new chats and replaces updated ones', () => {
      const projection = new GlyphWorkbenchProjection();
      const chat = {
        id: 'chat',
        title: 'First',
        accountProvider: 'openai',
        accountId: 'account',
        modelSlug: 'model',
        updatedAt: '2026-01-01T00:00:00.000Z',
        turnCount: 1,
      };
      projection.accept({ type: GlyphHostEventType.CHAT_UPDATED, chat });
      projection.accept({ type: GlyphHostEventType.CHAT_UPDATED, chat: { ...chat, title: 'Renamed' } });
      expect(projection.state.chats).toEqual([{ ...chat, title: 'Renamed' }]);
    });

    it('replaces only the restored chat runs', () => {
      const projection = new GlyphWorkbenchProjection();
      for (const chatId of ['chat', 'other'])
        projection.accept({
          type: GlyphHostEventType.RESPONSE_DELTA,
          chatId,
          runId: 'stale',
          delta: { kind: GlyphResponseDeltaKind.TEXT, value: 'stale' },
        });
      const restored = {
        chatId: 'chat',
        runId: 'restored',
        status: GlyphRunStatus.COMPLETED,
        text: 'restored',
        reasoning: '',
        tools: [],
      };
      projection.accept({
        type: GlyphHostEventType.CHAT_RESTORED,
        chatId: 'chat',
        runs: [restored],
        draft: { text: '', attachments: [] },
      });
      expect(projection.state.runs.map(run => [run.chatId, run.runId])).toEqual([
        ['other', 'stale'],
        ['chat', 'restored'],
      ]);
    });

    it('attributes changed proposals to their chat and replaces earlier versions', () => {
      const projection = new GlyphWorkbenchProjection();
      const proposal = { id: 'proposal', createdAt: '2026-01-01T00:00:00.000Z', files: [] };
      projection.accept({ type: GlyphHostEventType.PROPOSAL_CHANGED, chatId: 'old', proposal });
      projection.accept({ type: GlyphHostEventType.PROPOSAL_CHANGED, chatId: 'chat', proposal });
      expect(projection.state.proposals).toEqual([{ ...proposal, chatId: 'chat' }]);
    });

    it('records usage per chat', () => {
      const projection = new GlyphWorkbenchProjection();
      const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 };
      projection.accept({ type: GlyphHostEventType.USAGE, chatId: 'chat', usage });
      expect(projection.usage).toEqual({ chat: usage });
    });

    it('tracks non-disconnect statuses without altering runs or diagnostics', () => {
      const projection = new GlyphWorkbenchProjection();
      projection.accept({
        type: GlyphHostEventType.RESPONSE_DELTA,
        chatId: 'chat',
        runId: 'run',
        delta: { kind: GlyphResponseDeltaKind.TEXT, value: 'live' },
      });
      projection.accept({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.RECONNECTING });
      expect(projection.status).toBe(GlyphHostStatus.RECONNECTING);
      expect(projection.state.runs[0]?.status).toBe(GlyphRunStatus.STREAMING);
      expect(projection.diagnostics).toEqual([]);
    });

    it('marks shells as no longer live on disconnect and keeps settled runs unchanged', () => {
      const projection = new GlyphWorkbenchProjection();
      projection.accept({
        type: GlyphHostEventType.SHELL_SESSIONS,
        shells: [
          { id: 'shell', chatId: 'chat', command: 'npm test', workingDirectory: '/project', output: '', running: true },
        ],
      });
      projection.accept({
        type: GlyphHostEventType.RUN_STATE,
        run: {
          chatId: 'chat',
          runId: 'run',
          status: GlyphRunStatus.COMPLETED,
          text: 'done',
          reasoning: '',
          tools: [
            { id: 'read', name: 'read', status: GlyphToolActivityStatus.COMPLETED },
            {
              id: 'running',
              name: 'shell',
              status: GlyphToolActivityStatus.STARTED,
              shell: { command: 'sleep 9', output: 'z', background: true, live: true, running: true },
            },
            {
              id: 'finished',
              name: 'shell',
              status: GlyphToolActivityStatus.COMPLETED,
              shell: { command: 'true', output: '', background: false, live: true, running: false, exitCode: 0 },
            },
          ],
        },
      });
      projection.accept({ type: GlyphHostEventType.HOST_STATUS, status: GlyphHostStatus.DISCONNECTED });
      expect(projection.state.shells).toEqual([]);
      expect(projection.state.runs[0]?.status).toBe(GlyphRunStatus.COMPLETED);
      expect(projection.state.runs[0]?.tools).toEqual([
        { id: 'read', name: 'read', status: GlyphToolActivityStatus.COMPLETED },
        {
          id: 'running',
          name: 'shell',
          status: GlyphToolActivityStatus.STARTED,
          shell: {
            command: 'sleep 9',
            output: 'z',
            background: true,
            live: false,
            running: false,
            error: 'Shell interrupted when the host disconnected.',
          },
        },
        {
          id: 'finished',
          name: 'shell',
          status: GlyphToolActivityStatus.COMPLETED,
          shell: { command: 'true', output: '', background: false, live: false, running: false, exitCode: 0 },
        },
      ]);
      expect(projection.diagnostics).toEqual([]);
    });

    it('records unsolicited errors as diagnostics and ignores request-scoped ones', () => {
      const projection = new GlyphWorkbenchProjection();
      projection.accept({
        type: GlyphHostEventType.ERROR,
        requestId: 'request',
        error: { code: GlyphDesktopErrorCode.INTERNAL, message: 'Request failed', retryable: false },
      });
      projection.accept({
        type: GlyphHostEventType.ERROR,
        error: { code: GlyphDesktopErrorCode.HOST_UNAVAILABLE, message: 'Host failed', retryable: true },
      });
      expect(projection.diagnostics).toEqual(['Host failed']);
    });

    it('ignores command results', () => {
      const projection = new GlyphWorkbenchProjection();
      const before = projection.state;
      projection.accept({ type: GlyphHostEventType.COMMAND_RESULT, requestId: 'request', ok: true });
      expect(projection.state).toBe(before);
      expect(projection.diagnostics).toEqual([]);
    });

    it('records diagnostic deltas without changing the run', () => {
      const projection = new GlyphWorkbenchProjection();
      projection.accept({
        type: GlyphHostEventType.RESPONSE_DELTA,
        chatId: 'chat',
        runId: 'run',
        delta: { kind: GlyphResponseDeltaKind.DIAGNOSTIC, value: 'warning' },
      });
      expect(projection.diagnostics).toEqual(['warning']);
      expect(projection.state.runs).toEqual([]);
    });

    it('appends mode swaps carried by approvals to the run history', () => {
      const projection = new GlyphWorkbenchProjection();
      const modeSwap = {
        id: 'swap',
        source: AgentModeID.PLAN,
        target: AgentModeID.AGENT,
        description: 'Implement',
        status: GlyphModeSwapStatus.PENDING,
        expiresAt: '2026-01-01T00:00:00.000Z',
        autoApprove: false,
      };
      const approval = { id: 'approval', title: 'Switch', detail: 'mode', sandboxed: true, modeSwap };
      projection.accept({ type: GlyphHostEventType.APPROVAL, chatId: 'chat', runId: 'run', approval });
      projection.accept({
        type: GlyphHostEventType.APPROVAL,
        chatId: 'chat',
        runId: 'run',
        approval: { ...approval, id: 'second', modeSwap: { ...modeSwap, id: 'second' } },
      });
      expect(projection.state.runs[0]?.modeSwaps?.map(value => value.id)).toEqual(['swap', 'second']);
    });
  });
});
