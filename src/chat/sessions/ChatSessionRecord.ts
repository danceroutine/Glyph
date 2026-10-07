import type { ChatProviderState } from '../ChatProviderState.ts';

export interface ChatTranscriptTurn {
  readonly userText: string;
  readonly attachmentPaths: readonly string[];
  readonly assistantText: string;
  readonly reasoningSummary: string;
  readonly createdAt: string;
}

/** Durable state required to discover and resume one conversation. */
export interface ChatSessionRecord {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly title: string;
  readonly titleOrigin: 'placeholder' | 'generated' | 'human';
  readonly projectContextId: string;
  readonly accountClientId: string;
  readonly accountSubject: string;
  readonly modelSlug: string;
  readonly modelName: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly providerState: ChatProviderState;
  readonly transcript: readonly ChatTranscriptTurn[];
}

export type ChatSessionSummary = Omit<ChatSessionRecord, 'providerState' | 'transcript'> & {
  readonly turnCount: number;
};
