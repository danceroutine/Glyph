import { describe, expect, it } from 'vitest';
import { GlyphWorkbenchProjection } from '#src/desktop/workbench/GlyphWorkbenchProjection.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';

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
});
