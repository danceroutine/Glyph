import type { ChatSteeringQueue } from '#src/chat/ChatSteeringQueue.js';
import { AgentMode } from '#src/chat/AgentMode.js';
import type { GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { toToolActivityPreview } from '#src/chat/toToolActivityPreview.js';
import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import { ChatHistoryError } from './ChatHistoryError.ts';
import { toShellCommandSummary } from '#src/shell/toShellCommandSummary.js';
import type { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatRequestInput } from '#src/chat/ChatRequest.js';
import { toChatRequest } from '#src/chat/ChatRequest.js';
import type { ChatResponseStream } from '#src/chat/ChatResponseStream.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import type { ChatTurnResult } from '#src/chat/ChatTurnResult.js';
import type { ChatContextEvent } from '#src/chat/ChatContextEvent.js';
import type {
  ChatHistoryCheckpoint,
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
    private readonly replaceHistory?: (
      snapshot: ChatHistoryCheckpoint,
      turns: readonly ChatTranscriptTurn[],
    ) => Promise<void>,
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

  /** Serialize history changes with sends and durable tool receipts. */
  historyAt(turnId: string): Promise<{ record: ChatSessionRecord; index: number; turn: ChatTranscriptTurn }> {
    return this.enqueue(async () => {
      await this.persistOutstandingToolState();
      return this.findHistory(turnId);
    });
  }

  restoreCheckpoint(turnId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.persistOutstandingToolState();
      const { record, index, turn } = this.findHistory(turnId);
      if (!turn.checkpoints || !this.replaceHistory)
        throw new ChatHistoryError('This message has no saved checkpoint.');
      const previous = this.conversation.exportState();
      this.conversation.restoreState(turn.checkpoints.before.providerState);
      try {
        await this.replaceHistory(turn.checkpoints.before, record.transcript.slice(0, index));
      } catch (error) {
        this.conversation.restoreState(previous);
        throw error;
      }
    });
  }

  async reset(): Promise<void> {
    return this.enqueue(() => this.resetNow());
  }

  async recordContext(events: readonly ChatContextEvent[]): Promise<void> {
    if (events.length === 0) return;
    return this.enqueue(() => this.recordContextNow(events));
  }

  setTraceEnabled(enabled: boolean): void {
    this.conversation.setTraceEnabled(enabled);
  }

  async send(
    requestInput: ChatRequestInput,
    response: ChatResponseStream,
    signal: AbortSignal,
    questionResponses?: () => readonly GlyphQuestionResponse[],
    modeSwaps?: () => readonly GlyphModeSwap[],
    steering?: ChatSteeringQueue,
  ): Promise<ChatTurnResult> {
    return this.enqueue(() => this.sendNow(requestInput, response, signal, questionResponses, modeSwaps, steering));
  }

  private findHistory(turnId: string) {
    const record = this.record();
    const index = record.transcript.findIndex(
      (turn, position) => (turn.options?.turnId ?? `${record.id}:history:${position}`) === turnId,
    );
    const turn = record.transcript[index];
    if (!turn) throw new ChatHistoryError('This message is no longer in the conversation.');
    return { record, index, turn };
  }

  private historySnapshot(): ChatHistoryCheckpoint {
    const record = this.record();
    return structuredClone({
      providerState: this.conversation.exportState(),
      plans: record.plans ?? [],
      todos: record.todos ?? [],
      mode: record.mode ?? AgentMode.default.id,
    });
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

  private async sendNow(
    requestInput: ChatRequestInput,
    response: ChatResponseStream,
    signal: AbortSignal,
    questionResponses?: () => readonly GlyphQuestionResponse[],
    modeSwaps?: () => readonly GlyphModeSwap[],
    steering?: ChatSteeringQueue,
  ): Promise<ChatTurnResult> {
    await this.persistOutstandingToolState();
    const request = toChatRequest(requestInput);
    const before = this.historySnapshot();
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
            tools.set(callId, {
              callId,
              name,
              phase,
              arguments: toToolActivityPreview(part.activity.arguments),
              ...(part.activity.output ? { output: toToolActivityPreview(part.activity.output) } : {}),
              textOffset: tools.get(callId)?.textOffset ?? assistantText.length,
              ...(shell ? { shell } : {}),
            });
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
        ...(steering ? { takeSteering: steering.take } : {}),
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
        checkpoints: { before, after: this.historySnapshot() },
        ...(questionResponses ? { questionResponses: questionResponses() } : {}),
        ...(modeSwaps ? { modeSwaps: modeSwaps() } : {}),
        ...(steering?.messages.length ? { steering: steering.messages } : {}),
        userText: request.text,
        options: {
          ...(request.attachmentSpans ? { attachmentSpans: request.attachmentSpans } : {}),
          ...(request.turnId ? { turnId: request.turnId } : {}),
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.annotations ? { annotations: request.annotations } : {}),
        },
        attachmentPaths: request.attachments.map(attachment => attachment.path),
        ...(request.attachments.length ? { attachments: request.attachments } : {}),
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
  return {
    ...summary,
    mode: record.mode ?? transcript.at(-1)?.options?.mode ?? AgentMode.default.id,
    turnCount: transcript.length,
  };
}
