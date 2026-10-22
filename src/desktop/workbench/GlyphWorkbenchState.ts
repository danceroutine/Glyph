import type { GlyphDesktopSnapshot } from '#src/desktop/protocol/events/GlyphDesktopSnapshot.js';
import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';
import type { GlyphTranscriptEntry } from './GlyphTranscriptEntry.ts';

export enum GlyphWorkbenchStatus {
  READY = 'ready',
  STREAMING = 'streaming',
  DISCONNECTED = 'disconnected',
  WAITING_FOR_QUESTION = 'waiting_for_question',
  WAITING_FOR_APPROVAL = 'waiting_for_approval',
}

/** Minimal sidebar state; the host remains authoritative for durable chat state. */
export interface GlyphWorkbenchState extends GlyphDesktopSnapshot {
  readonly status: GlyphWorkbenchStatus;
  readonly transcript: readonly GlyphTranscriptEntry[];
  readonly selectedChatId?: string;
  /** Window-owned open tabs. The empty ID is the unsent new-chat draft. */
  readonly openChatIds?: readonly string[];
  readonly newChatDraft?: { readonly text: string; readonly createdAt: string };
  readonly archivedChatIds?: readonly string[];
  readonly pinnedChatIds?: readonly string[];
  readonly usage: Readonly<Record<string, GlyphUsage>>;
  readonly navigationPending?: boolean;
  readonly catalogPending?: boolean;
  readonly navigationError?: string;
  readonly workspaceMessage?: string;
  readonly workspaceRetryable?: boolean;
}
