import { toShellCommandSummary } from '#src/shell/toShellCommandSummary.js';
import type { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatRequestInput } from '#src/chat/ChatRequest.js';
import { toChatRequest } from '#src/chat/ChatRequest.js';
import type { ChatResponseStream } from '#src/chat/ChatResponseStream.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import type { ChatTurnResult } from '#src/chat/ChatTurnResult.js';
import type { ChatContextEvent } from '#src/chat/ChatContextEvent.js';
import type {
  ChatSessionRecord,
  ChatSessionSummary,
  ChatTranscriptTurn,
  ChatToolSummary,
} from './ChatSessionRecord.ts';
import { toChatUsage, type ChatUsage } from './ChatUsage.ts';

type Checkpoint = (
  providerState: ReturnType<ChatConversation['exportState']>,
  turn?: ChatTranscriptTurn,
  preserveTranscript?: boolean,
) => Promise<void>;

/** A resumable conversation whose completed turns are checkpointed atomically. */
export class ChatSession {
  private unpersistedProviderState: ReturnType<ChatConversation['exportState']> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly record: () => ChatSessionRecord,
    private readonly conversation: ChatConversation,
    private readonly checkpoint: Checkpoint,
  ) {}

  get id(): string {
    return this.record().id;
  }

  get model(): string {
    return this.conversation.model;
  }

  get isTraceEnabled(): boolean {
    return this.conversation.isTraceEnabled;
  }

  get summary(): ChatSessionSummary {
    return toSummary(this.record());
  }

  get transcript(): readonly ChatTranscriptTurn[] {
    return this.record().transcript;
  }

  get usage(): ChatUsage {
    return toChatUsage(this.transcript);
  }

  async reset(): Promise<void> {
    return this.enqueue(() => this.resetNow());
  }

  private async resetNow(): Promise<void> {
    await this.persistOutstandingToolState();
    const previousState = this.conversation.exportState();
    this.conversation.reset();
    try {
      await this.checkpoint(this.conversation.exportState());
    } catch (error) {
      this.conversation.restoreState(previousState);
      throw error;
    }
  }

  async recordContext(events: readonly ChatContextEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.enqueue(() => this.recordContextNow(events));
  }

  private async recordContextNow(events: readonly ChatContextEvent[]): Promise<void> {
    await this.persistOutstandingToolState();
    const previousState = this.conversation.exportState();
    this.conversation.recordContext(events);
    try {
      await this.checkpoint(this.conversation.exportState(), undefined, true);
    } catch (error) {
      this.conversation.restoreState(previousState);
      throw error;
    }
  }

  setTraceEnabled(enabled: boolean): void {
    this.conversation.setTraceEnabled(enabled);
  }

  async send(
    requestInput: ChatRequestInput,
    response: ChatResponseStream,
    signal: AbortSignal,
  ): Promise<ChatTurnResult> {
    return this.enqueue(() => this.sendNow(requestInput, response, signal));
  }

  private async sendNow(
    requestInput: ChatRequestInput,
    response: ChatResponseStream,
    signal: AbortSignal,
  ): Promise<ChatTurnResult> {
    await this.persistOutstandingToolState();
    const request = toChatRequest(requestInput);
    const previousState = this.conversation.exportState();
    let durableState = previousState;
    let assistantText = '';
    let reasoningSummary = '';
    const tools = new Map<string, ChatToolSummary>();
    const recordingResponse: ChatResponseStream = {
      push: part => {
        switch (part.type) {
          case ChatResponsePartType.TEXT:
            assistantText += part.value;
            break;
          case ChatResponsePartType.REASONING_SUMMARY:
            reasoningSummary += part.value;
            break;
          case ChatResponsePartType.TOOL: {
            const { callId, name, phase } = part.activity;
            const shell = toShellCommandSummary(part.activity);
            tools.set(callId, { callId, name, phase, ...(shell ? { shell } : {}) });
            break;
          }
          case ChatResponsePartType.DIAGNOSTIC:
            break;
        }
        response.push(part);
      },
    };
    const currentRecord = this.record();
    let result: ChatTurnResult;
    try {
      result = await this.conversation.send(request, recordingResponse, signal, {
        onStateCheckpoint: async state => {
          this.unpersistedProviderState = state;
          await this.checkpoint(state, undefined, true);
          durableState = state;
          this.unpersistedProviderState = undefined;
        },
        toolContext: {
          chat: {
            id: currentRecord.id,
            accountProvider: currentRecord.accountProvider,
            accountId: currentRecord.accountId,
          },
        },
      });
    } catch (error) {
      this.conversation.restoreState(this.unpersistedProviderState ?? durableState);
      throw error;
    }
    try {
      await this.checkpoint(this.conversation.exportState(), {
        userText: request.text,
        attachmentPaths: request.attachments.map(attachment => attachment.path),
        assistantText,
        reasoningSummary,
        ...(result.usage ? { usage: result.usage } : {}),
        tools: [...tools.values()],
        createdAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.conversation.restoreState(durableState);
      throw error;
    }
  }

  private async persistOutstandingToolState(): Promise<void> {
    const state = this.unpersistedProviderState;
    if (!state) return;
    await this.checkpoint(state, undefined, true);
    this.unpersistedProviderState = undefined;
    this.conversation.restoreState(state);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

export function toSummary(record: ChatSessionRecord): ChatSessionSummary {
  const { providerState: _, transcript, ...summary } = record;
  return { ...summary, turnCount: transcript.length };
}
