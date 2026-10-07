import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatContextEvent } from '../../ChatContextEvent.ts';
import type { ChatProviderState } from '../../ChatProviderState.ts';
import type { ChatRequest } from '../../ChatRequest.ts';
import type { ToolRuntime } from '../../../tools/ToolRuntime.ts';
import { AgentRuntime } from '../AgentRuntime.ts';
import type { AgentModelAdapter, AgentToolResult, AgentTurnContext, AgentTurnStep } from '../AgentModelAdapter.ts';

type ClaudeBlock =
  | { readonly type: 'thinking'; readonly thinking: string; readonly signature: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string }
  | { readonly type: 'text'; readonly text: string };

interface ClaudeMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ClaudeBlock[];
}

interface ClaudeTurn {
  readonly messages: readonly ClaudeMessage[];
  readonly round: number;
}

class ClaudeShapedAdapter implements AgentModelAdapter<ClaudeTurn> {
  readonly model = 'claude-fixture';
  readonly requests: ClaudeTurn[] = [];

  emptyState(): ChatProviderState {
    return claudeState([]);
  }

  restoreState(state: ChatProviderState): ChatProviderState {
    return claudeState(messagesFrom(state));
  }

  recoverInterruptedToolCalls(state: ChatProviderState) {
    const messages = messagesFrom(state);
    const settled = new Set(
      messages.flatMap(message =>
        typeof message.content === 'string'
          ? []
          : message.content.flatMap(block => (block.type === 'tool_result' ? [block.tool_use_id] : [])),
      ),
    );
    const pending = messages.flatMap(message =>
      typeof message.content === 'string'
        ? []
        : message.content.filter(
            (block): block is Extract<ClaudeBlock, { type: 'tool_use' }> =>
              block.type === 'tool_use' && !settled.has(block.id),
          ),
    );
    if (pending.length === 0) return { state: claudeState(messages), recoveredCallCount: 0 };
    return {
      state: claudeState([
        ...messages,
        {
          role: 'user',
          content: pending.map(call => ({
            type: 'tool_result' as const,
            tool_use_id: call.id,
            content: interruptedOutput(),
          })),
        },
      ]),
      recoveredCallCount: pending.length,
    };
  }

  recordContext(state: ChatProviderState, _events: readonly ChatContextEvent[]): ChatProviderState {
    return state;
  }

  async beginTurn(state: ChatProviderState, request: ChatRequest, _context: AgentTurnContext): Promise<ClaudeTurn> {
    return { messages: [...messagesFrom(state), { role: 'user', content: request.text }], round: 0 };
  }

  async streamStep(turn: ClaudeTurn, context: AgentTurnContext): Promise<AgentTurnStep<ClaudeTurn>> {
    this.requests.push(structuredClone(turn));
    if (turn.round === 0) {
      context.onReasoningSummary?.('Inspecting the file.');
      const assistant: ClaudeMessage = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'opaque reasoning', signature: 'signed-thinking' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
        ],
      };
      return {
        turn: { messages: [...turn.messages, assistant], round: 1 },
        responseId: 'msg_tool',
        usage: usage(5, 3),
        hasVisibleOutput: false,
        toolCalls: [
          {
            id: 'toolu_1',
            name: 'read_file',
            input: JSON.stringify({ path: 'README.md' }),
          },
        ],
      };
    }
    context.onText('Done.');
    return {
      turn: {
        messages: [...turn.messages, { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
        round: 2,
      },
      responseId: 'msg_final',
      usage: usage(8, 2),
      hasVisibleOutput: true,
      toolCalls: [],
    };
  }

  appendToolResults(turn: ClaudeTurn, results: readonly AgentToolResult[]): ClaudeTurn {
    return {
      messages: [
        ...turn.messages,
        {
          role: 'user',
          content: results.map(result => ({
            type: 'tool_result' as const,
            tool_use_id: result.call.id,
            content: result.output,
          })),
        },
      ],
      round: turn.round,
    };
  }

  commit(turn: ClaudeTurn): ChatProviderState {
    return claudeState(turn.messages);
  }
}

class TwoToolClaudeAdapter extends ClaudeShapedAdapter {
  override async streamStep(turn: ClaudeTurn, context: AgentTurnContext): Promise<AgentTurnStep<ClaudeTurn>> {
    if (turn.round !== 0) return super.streamStep(turn, context);
    const calls = [
      { id: 'toolu_1', name: 'first_tool', input: '{}' },
      { id: 'toolu_2', name: 'second_tool', input: '{}' },
    ] as const;
    return {
      turn: {
        messages: [
          ...turn.messages,
          {
            role: 'assistant',
            content: calls.map(call => ({
              type: 'tool_use' as const,
              id: call.id,
              name: call.name,
              input: {},
            })),
          },
        ],
        round: 1,
      },
      responseId: 'msg_tools',
      usage: usage(5, 1),
      hasVisibleOutput: false,
      toolCalls: calls,
    };
  }
}

describe(AgentRuntime, () => {
  it('supports Claude-shaped messages while keeping tool execution provider-independent', async () => {
    const adapter = new ClaudeShapedAdapter();
    const tools: ToolRuntime = {
      definitions: [],
      execute: vi.fn(async (_name, input) => `contents for ${JSON.parse(input).path as string}`),
    };
    const runtime = new AgentRuntime(adapter, { timeoutMs: 10_000 }, tools);
    let text = '';

    const result = await runtime.send('Read the file.', {
      signal: new AbortController().signal,
      onText: delta => {
        text += delta;
      },
    });

    expect(result).toEqual({ responseId: 'msg_final', usage: usage(13, 5) });
    expect(text).toBe('Done.');
    expect(tools.execute).toHaveBeenCalledWith(
      'read_file',
      JSON.stringify({ path: 'README.md' }),
      expect.any(AbortSignal),
    );
    expect(adapter.requests[1]?.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'opaque reasoning', signature: 'signed-thinking' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'README.md' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'contents for README.md' }],
      },
    ]);
    expect(messagesFrom(runtime.exportState()).at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
    });
  });

  it('commits tool results before a later model round fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-tool-checkpoint-'));
    const marker = join(directory, 'marker.txt');
    const adapter = new ClaudeShapedAdapter();
    const originalStreamStep = adapter.streamStep.bind(adapter);
    adapter.streamStep = async (turn, context) => {
      if (turn.round > 0) throw new Error('provider failed after mutation');
      return originalStreamStep(turn, context);
    };
    const tools: ToolRuntime = {
      definitions: [],
      execute: vi.fn(async () => {
        await writeFile(marker, 'I win');
        return 'workspace mutation receipt';
      }),
    };
    const runtime = new AgentRuntime(adapter, { timeoutMs: 10_000 }, tools);
    const checkpoints: ChatProviderState[] = [];

    await expect(
      runtime.send('Change the file.', {
        signal: new AbortController().signal,
        onText: () => {},
        onStateCheckpoint: state => {
          checkpoints.push(state);
        },
      }),
    ).rejects.toThrow('provider failed after mutation');

    expect(checkpoints).toHaveLength(2);
    expect(messagesFrom(checkpoints[0]!).at(-1)).toMatchObject({ role: 'assistant' });
    expect(messagesFrom(checkpoints[1]!).at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'workspace mutation receipt' }],
    });
    expect(runtime.exportState()).toEqual(checkpoints[1]);
    await expect(readFile(marker, 'utf8')).resolves.toBe('I win');
    await rm(directory, { recursive: true, force: true });
  });

  it('checkpoints an unknown outcome when cancellation follows a side effect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-tool-cancellation-'));
    const marker = join(directory, 'marker.txt');
    const controller = new AbortController();
    const adapter = new ClaudeShapedAdapter();
    const tools: ToolRuntime = {
      definitions: [],
      execute: vi.fn(async (_name, _input, signal) => {
        await writeFile(marker, 'I win');
        controller.abort(new Error('cancel after readiness'));
        signal?.throwIfAborted();
        return 'unreachable';
      }),
    };
    const runtime = new AgentRuntime(adapter, { timeoutMs: 10_000 }, tools);
    const checkpoints: ChatProviderState[] = [];

    await expect(
      runtime.send('Run until ready.', {
        signal: controller.signal,
        onText: () => {},
        onStateCheckpoint: state => {
          checkpoints.push(state);
        },
      }),
    ).rejects.toThrow('Response cancelled');

    expect(checkpoints).toHaveLength(2);
    const result = messagesFrom(checkpoints[1]!).at(-1) as {
      readonly content: readonly Extract<ClaudeBlock, { type: 'tool_result' }>[];
    };
    expect(JSON.parse(result.content[0]!.content)).toMatchObject({
      error: { code: 'TOOL_EXECUTION_INTERRUPTED', outcome: 'unknown' },
    });
    expect(runtime.exportState()).toEqual(checkpoints[1]);
    await expect(readFile(marker, 'utf8')).resolves.toBe('I win');
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves each sibling outcome when another tool throws', async () => {
    const adapter = new TwoToolClaudeAdapter();
    let firstPending = false;
    let secondObservedFirstPending = false;
    const tools: ToolRuntime = {
      definitions: [],
      execute: vi.fn(async name => {
        if (name === 'second_tool') {
          secondObservedFirstPending = firstPending;
          throw new Error('second tool failed');
        }
        firstPending = true;
        await new Promise(resolve => setImmediate(resolve));
        firstPending = false;
        return 'first completed';
      }),
    };
    const runtime = new AgentRuntime(adapter, { timeoutMs: 10_000 }, tools);
    const checkpoints: ChatProviderState[] = [];

    await runtime.send('Run both.', {
      signal: new AbortController().signal,
      onText: () => {},
      onStateCheckpoint: state => {
        checkpoints.push(state);
      },
    });

    expect(checkpoints).toHaveLength(2);
    expect(secondObservedFirstPending).toBe(true);
    const failed = messagesFrom(checkpoints[1]!).at(-1) as {
      readonly content: readonly Extract<ClaudeBlock, { type: 'tool_result' }>[];
    };
    expect(failed.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'first completed',
    });
    expect(JSON.parse(failed.content[1]!.content)).toMatchObject({
      error: { code: 'TOOL_EXECUTION_FAILED', outcome: 'unknown' },
    });
  });

  it('does not launch tools when their execution intent cannot be checkpointed', async () => {
    const adapter = new ClaudeShapedAdapter();
    const tools: ToolRuntime = {
      definitions: [],
      execute: vi.fn(async () => 'must not run'),
    };
    const runtime = new AgentRuntime(adapter, { timeoutMs: 10_000 }, tools);

    await expect(
      runtime.send('Change the file.', {
        signal: new AbortController().signal,
        onText: () => {},
        onStateCheckpoint: () => {
          throw new Error('intent persistence failed');
        },
      }),
    ).rejects.toThrow('intent persistence failed');

    expect(tools.execute).not.toHaveBeenCalled();
    const intent = messagesFrom(runtime.exportState()).at(-1);
    expect(intent?.role).toBe('assistant');
    expect(intent?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_use', id: 'toolu_1' })]),
    );
  });
});

function claudeState(messages: readonly ClaudeMessage[]): ChatProviderState {
  return { provider: 'claude-messages', version: 1, data: { messages: structuredClone(messages) } };
}

function messagesFrom(state: ChatProviderState): ClaudeMessage[] {
  if (state.provider !== 'claude-messages') throw new Error('Incompatible state.');
  return structuredClone((state.data as { messages: ClaudeMessage[] }).messages);
}

function interruptedOutput(): string {
  return JSON.stringify({
    error: {
      code: 'TOOL_EXECUTION_INTERRUPTED',
      message: 'Glyph restarted before this tool reported an outcome; side effects may have occurred.',
      outcome: 'unknown',
    },
  });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}
