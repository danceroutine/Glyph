import { describe, expect, it, vi } from 'vitest';
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
});

function claudeState(messages: readonly ClaudeMessage[]): ChatProviderState {
  return { provider: 'claude-messages', version: 1, data: { messages: structuredClone(messages) } };
}

function messagesFrom(state: ChatProviderState): ClaudeMessage[] {
  if (state.provider !== 'claude-messages') throw new Error('Incompatible state.');
  return structuredClone((state.data as { messages: ClaudeMessage[] }).messages);
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
