import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { ContextAttachment } from '#src/context/attachments/ContextAttachment.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { TurnUsage } from '#src/chat/TurnUsage.js';
import type { ShellCommandSummary } from '#src/shell/ShellCommandSummary.js';
import type { ToolActivity } from '#src/chat/ToolActivity.js';
import type { TodoItem } from '#src/todos/TodoItem.js';

/** Compact activity history with bounded shell display data; provider history owns complete tool results. */
export type ChatToolSummary = Pick<ToolActivity, 'callId' | 'name' | 'phase'> & {
  readonly shell?: ShellCommandSummary;
};

export interface ChatHistoryCheckpoint {
  readonly providerState: ChatProviderState;
  readonly plans: readonly GlyphPlan[];
  readonly todos: readonly TodoItem[];
  readonly mode: 'agent' | 'plan';
}

export interface ChatTranscriptTurn {
  readonly questionResponses?: readonly GlyphQuestionResponse[];
  readonly checkpoints?: { readonly before: ChatHistoryCheckpoint; readonly after: ChatHistoryCheckpoint };
  readonly options?: GlyphTurnOptions;
  readonly userText: string;
  readonly attachments?: readonly ContextAttachment[];
  readonly attachmentPaths: readonly string[];
  readonly assistantText: string;
  readonly reasoningSummary: string;
  readonly usage?: TurnUsage;
  readonly tools?: readonly ChatToolSummary[];
  readonly createdAt: string;
}

/** Durable state required to discover and resume one conversation. */
export interface ChatSessionRecord {
  readonly schemaVersion: 3;
  readonly mode?: 'agent' | 'plan';
  readonly id: string;
  readonly title: string;
  readonly titleOrigin: 'placeholder' | 'generated' | 'human';
  readonly projectContextId: string;
  readonly accountProvider: string;
  readonly accountId: string;
  readonly modelSlug: string;
  readonly modelName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerState: ChatProviderState;
  readonly transcript: readonly ChatTranscriptTurn[];
  readonly plans?: readonly GlyphPlan[];
  readonly todos?: readonly TodoItem[];
}

export type ChatSessionSummary = Omit<ChatSessionRecord, 'providerState' | 'transcript'> & {
  readonly mode?: 'agent' | 'plan';
  readonly turnCount: number;
};
