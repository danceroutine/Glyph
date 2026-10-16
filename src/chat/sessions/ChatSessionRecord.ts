import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { TurnUsage } from '#src/chat/TurnUsage.js';
import type { ShellCommandSummary } from '#src/shell/ShellCommandSummary.js';
import type { ToolActivity } from '#src/chat/ToolActivity.js';
import type { TodoItem } from '#src/todos/TodoItem.js';

/** Compact activity history with bounded shell display data; provider history owns complete tool results. */
export type ChatToolSummary = Pick<ToolActivity, 'callId' | 'name' | 'phase'> & {
  readonly shell?: ShellCommandSummary;
};

export interface ChatTranscriptTurn {
  readonly userText: string;
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
  readonly todos?: readonly TodoItem[];
}

export type ChatSessionSummary = Omit<ChatSessionRecord, 'providerState' | 'transcript'> & {
  readonly turnCount: number;
};
