import type { ChatConversation } from '../ChatConversation.ts';
import type { ChatRequestInput } from '../ChatRequest.ts';
import { toChatRequest } from '../ChatRequest.ts';
import type { ChatResponseStream } from '../ChatResponseStream.ts';
import { ChatResponsePartType } from '../ChatResponsePartType.ts';
import type { ChatTurnResult } from '../ChatTurnResult.ts';
import type { ChatContextEvent } from '../ChatContextEvent.ts';
import type { ChatSessionRecord, ChatSessionSummary, ChatTranscriptTurn } from './ChatSessionRecord.ts';

type Checkpoint = (
  providerState: ReturnType<ChatConversation['exportState']>,
  turn?: ChatTranscriptTurn,
  preserveTranscript?: boolean,
) => Promise<void>;

/** A resumable conversation whose completed turns are checkpointed atomically. */
export class ChatSession {
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

  async reset(): Promise<void> {
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
    const request = toChatRequest(requestInput);
    const previousState = this.conversation.exportState();
    let durableState = previousState;
    let assistantText = '';
    let reasoningSummary = '';
    const recordingResponse: ChatResponseStream = {
      push: part => {
        if (part.type === ChatResponsePartType.TEXT) assistantText += part.value;
        if (part.type === ChatResponsePartType.REASONING_SUMMARY) reasoningSummary += part.value;
        response.push(part);
      },
    };
    const currentRecord = this.record();
    let result: ChatTurnResult;
    try {
      result = await this.conversation.send(request, recordingResponse, signal, {
        onStateCheckpoint: async state => {
          await this.checkpoint(state, undefined, true);
          durableState = state;
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
      this.conversation.restoreState(durableState);
      throw error;
    }
    try {
      await this.checkpoint(this.conversation.exportState(), {
        userText: request.text,
        attachmentPaths: request.attachments.map(attachment => attachment.path),
        assistantText,
        reasoningSummary,
        createdAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      this.conversation.restoreState(durableState);
      throw error;
    }
  }
}

export function toSummary(record: ChatSessionRecord): ChatSessionSummary {
  const { providerState: _, transcript, ...summary } = record;
  return { ...summary, turnCount: transcript.length };
}
