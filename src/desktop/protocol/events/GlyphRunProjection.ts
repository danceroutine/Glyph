import type { GlyphQuestionResponse } from '#src/desktop/protocol/events/GlyphQuestionResponse.js';
import type { GlyphUsage } from './GlyphUsage.ts';
import type { GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphAttachmentPreview } from './GlyphAttachmentPreview.ts';
import type { GlyphToolActivity } from './GlyphToolActivity.ts';
import type { GlyphQuestionRequest } from './GlyphQuestionRequest.ts';
import type { GlyphApprovalRequest } from './GlyphApprovalRequest.ts';

export enum GlyphRunStatus {
  STREAMING = 'streaming',
  WAITING_FOR_QUESTION = 'waiting_for_question',
  WAITING_FOR_APPROVAL = 'waiting_for_approval',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  INTERRUPTED = 'interrupted',
  FAILED = 'failed',
}

export interface GlyphRunProjection {
  readonly chatId: string;
  readonly runId: string;
  readonly status: GlyphRunStatus;
  readonly text: string;
  readonly options?: GlyphTurnOptions;
  readonly attachments?: readonly GlyphAttachmentPreview[];
  readonly userText?: string;
  readonly checkpointTurnId?: string;
  readonly createdAt?: string;
  readonly questionResponses?: readonly GlyphQuestionResponse[];
  readonly usage?: GlyphUsage;
  readonly reasoning: string;
  readonly tools: readonly GlyphToolActivity[];
  readonly question?: GlyphQuestionRequest;
  readonly approval?: GlyphApprovalRequest;
  readonly terminalMessage?: string;
}
