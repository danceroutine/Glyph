import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { DiagnosticSeverity } from '#src/chat/DiagnosticSeverity.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { ProviderError } from '#src/errors/ProviderError.js';
import type { Logger } from '#src/observability/Logger.js';

function fakeProvider(send: ChatProvider['send']): ChatProvider {
  return {
    model: 'test-model',
    recordContext: vi.fn(),
    exportState: vi.fn(() => ({ provider: 'fake', version: 1, data: { history: [] } })),
    restoreState: vi.fn(),
    reset: vi.fn(),
    send: vi.fn(send),
  };
}

function fakeLogger() {
  const trace = vi.fn<Logger['trace']>();
  const logger: Logger = {
    forNamespace: () => logger,
    trace,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return Object.assign(logger, { trace });
}

function collector(): { parts: ChatResponsePart[]; push: (part: ChatResponsePart) => void } {
  const parts: ChatResponsePart[] = [];
  return { parts, push: part => parts.push(part) };
}

describe(ChatConversation, () => {
  it('exposes the provider model and its trace setting', () => {
    const conversation = new ChatConversation(
      fakeProvider(async () => ({ responseId: 'r', usage: null })),
      fakeLogger(),
      value => value,
      vi.fn(),
      false,
    );

    expect(conversation.model).toBe('test-model');
    expect(conversation.isTraceEnabled).toBe(false);
    conversation.setTraceEnabled(true);
    expect(conversation.isTraceEnabled).toBe(true);
  });

  it('delegates history operations to the provider', () => {
    const provider = fakeProvider(async () => ({ responseId: 'r', usage: null }));
    const conversation = new ChatConversation(provider, fakeLogger(), value => value, vi.fn(), false);
    const state = { provider: 'fake', version: 1, data: { history: ['saved'] } };
    const events = [{ schemaVersion: 1 as const, id: 'event', type: 'note', payload: {} }];

    expect(conversation.exportState()).toEqual({ provider: 'fake', version: 1, data: { history: [] } });
    conversation.recordContext(events);
    conversation.restoreState(state);
    conversation.reset();

    expect(provider.recordContext).toHaveBeenCalledWith(events);
    expect(provider.restoreState).toHaveBeenCalledWith(state);
    expect(provider.reset).toHaveBeenCalledOnce();
  });

  describe(ChatConversation.prototype.send, () => {
    it('streams provider output as response parts and records usage', async () => {
      const activity = { phase: ToolActivityPhase.STARTED, name: 'read', callId: 'call', arguments: '{}' };
      const provider = fakeProvider(async (_request, options) => {
        options.onText('Hello');
        options.onReasoningSummary?.('Thinking');
        options.onToolActivity?.(activity);
        options.onTrace?.({ sequence: 1, timestamp: 'now', kind: 'ignored', data: {} });
        return { responseId: 'resp', usage: null };
      });
      const recordUsage = vi.fn();
      const logger = fakeLogger();
      const conversation = new ChatConversation(provider, logger, value => value, recordUsage, false);
      const response = collector();

      const result = await conversation.send('hi', response, new AbortController().signal);

      expect(response.parts).toEqual([
        { type: ChatResponsePartType.TEXT, value: 'Hello' },
        { type: ChatResponsePartType.REASONING_SUMMARY, value: 'Thinking' },
        { type: ChatResponsePartType.TOOL, activity },
      ]);
      expect(result).toEqual({ responseId: 'resp', usage: null, durationMs: expect.any(Number) });
      expect(recordUsage).toHaveBeenCalledWith({ responseId: 'resp', usage: null });
      expect(logger.trace).not.toHaveBeenCalled();
    });

    it('forwards checkpoint, steering, and tool context options to the provider', async () => {
      const provider = fakeProvider(async () => ({ responseId: 'resp', usage: null }));
      const conversation = new ChatConversation(provider, fakeLogger(), value => value, vi.fn(), false);
      const onStateCheckpoint = vi.fn();
      const takeSteering = vi.fn(() => []);
      const toolContext = { mode: AgentModeID.PLAN };
      const signal = new AbortController().signal;

      await conversation.send('hi', collector(), signal, { onStateCheckpoint, takeSteering, toolContext });

      expect(provider.send).toHaveBeenCalledWith(
        'hi',
        expect.objectContaining({ signal, onStateCheckpoint, takeSteering, toolContext }),
      );
    });

    it('writes redacted provider traces when tracing is enabled', async () => {
      const provider = fakeProvider(async (_request, options) => {
        options.onTrace?.({ sequence: 1, timestamp: 'now', kind: 'request.body', data: { token: 'secret' } });
        return { responseId: 'resp', usage: null };
      });
      const logger = fakeLogger();
      const conversation = new ChatConversation(
        provider,
        logger,
        value => value.replaceAll('secret', '[REDACTED]'),
        vi.fn(),
        true,
      );

      await conversation.send('hi', collector(), new AbortController().signal);

      expect(logger.trace).toHaveBeenCalledWith('provider.trace', [
        { sequence: 1, timestamp: 'now', kind: 'request.body', data: { token: '[REDACTED]' } },
      ]);
    });

    it.each([
      ['an error', new Error('disk full secret'), 'Trace log write failed: disk full [REDACTED]'],
      ['a non-error value', 'quota secret', 'Trace log write failed: quota [REDACTED]'],
    ])('reports a diagnostic when writing the trace fails with %s', async (_case, failure, message) => {
      const logger = fakeLogger();
      logger.trace.mockRejectedValue(failure);
      const conversation = new ChatConversation(
        fakeProvider(async () => ({ responseId: 'resp', usage: null })),
        logger,
        value => value.replaceAll('secret', '[REDACTED]'),
        vi.fn(),
        true,
      );
      const response = collector();

      await conversation.send('hi', response, new AbortController().signal);

      expect(response.parts).toEqual([
        { type: ChatResponsePartType.DIAGNOSTIC, severity: DiagnosticSeverity.ERROR, message },
      ]);
    });

    it('writes the trace and rethrows when the provider fails', async () => {
      const failure = new Error('provider failed');
      const logger = fakeLogger();
      const recordUsage = vi.fn();
      const conversation = new ChatConversation(
        fakeProvider(async () => {
          throw failure;
        }),
        logger,
        value => value,
        recordUsage,
        true,
      );

      await expect(conversation.send('hi', collector(), new AbortController().signal)).rejects.toBe(failure);
      expect(logger.trace).toHaveBeenCalledWith('provider.trace', []);
      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('rejects a provider that completes without a result', async () => {
      const conversation = new ChatConversation(
        fakeProvider(async () => undefined as unknown as Awaited<ReturnType<ChatProvider['send']>>),
        fakeLogger(),
        value => value,
        vi.fn(),
        false,
      );

      await expect(conversation.send('hi', collector(), new AbortController().signal)).rejects.toThrow(
        new ProviderError('Provider completed without a result.'),
      );
    });
  });
});
