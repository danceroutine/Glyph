import OpenAI from 'openai';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { Config } from './config.ts';
import type { ChatProvider, TurnResult } from './provider.ts';

export class OpenAIProvider implements ChatProvider {
  readonly model: string;
  private readonly client: OpenAI | undefined;
  private readonly token: () => Promise<string>;
  private readonly config: Config;
  private history: ResponseInputItem[] = [];
  private busy = false;

  constructor(config: Config, token: () => Promise<string>, client?: OpenAI) {
    this.config = config;
    this.model = config.model;
    this.token = token;
    this.client = client;
  }

  reset(): void {
    if (this.busy) throw new Error('Cannot reset during a response. Cancel it first.');
    this.history = [];
  }

  async send(text: string, options: {
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnResult> {
    if (this.busy) throw new Error('A response is already in progress.');
    if (!text.trim()) throw new Error('Message cannot be empty.');
    this.busy = true;
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    const input: ResponseInputItem[] = [...this.history, { role: 'user', content: text }];
    try {
      const accessToken = await this.token();
      signal.throwIfAborted();
      const client = this.client ?? new OpenAI({
        apiKey: accessToken,
        baseURL: 'https://api.openai.com/v1',
        organization: null,
        project: null,
        maxRetries: 0,
        logLevel: 'off',
      });
      const stream = await client.responses.create({
        model: this.model,
        instructions: this.config.instructions,
        input,
        stream: true,
        store: false,
        // Preserve opaque reasoning state for stateless multi-turn reasoning models.
        include: ['reasoning.encrypted_content'],
      }, { signal });
      let result: TurnResult | undefined;
      let output: ResponseInputItem[] | undefined;
      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_text.delta':
          case 'response.refusal.delta':
            options.onText(event.delta);
            break;
          case 'response.completed': {
            output = event.response.output.map(item => {
              if (item.type === 'message' || item.type === 'reasoning') return item;
              throw new Error(`Unexpected output type for text-only chat: ${item.type}`);
            });
            const usage = event.response.usage;
            result = {
              responseId: event.response.id,
              usage: usage ? {
                inputTokens: usage.input_tokens,
                cachedInputTokens: usage.input_tokens_details.cached_tokens,
                outputTokens: usage.output_tokens,
                reasoningTokens: usage.output_tokens_details.reasoning_tokens,
                totalTokens: usage.total_tokens,
              } : null,
            };
            break;
          }
          case 'response.incomplete':
            throw new Error(`Response incomplete (${event.response.incomplete_details?.reason ?? 'unknown'}). Try a shorter request.`);
          case 'response.failed':
            throw new Error(`Response failed: ${`${event.response.error?.code ?? 'unknown'}: ${event.response.error?.message ?? 'unknown error'}`}`);
          case 'error':
            throw new Error(`API stream error: ${event.message}`);
        }
      }
      signal.throwIfAborted();
      if (!result || !output) throw new Error('Connection ended before the response completed.');
      // Only commit a complete turn. Failures/cancellation leave prior context intact.
      this.history = [...input, ...output];
      return result;
    } catch (error) {
      if (options.signal.aborted) throw new Error('Response cancelled.');
      if (timeout.aborted) throw new Error(`Response timed out after ${this.config.timeoutMs} ms.`);
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
