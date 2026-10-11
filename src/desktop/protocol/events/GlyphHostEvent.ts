import type { GlyphHostStatus } from './GlyphHostStatus.ts';
import type { GlyphCommandResultHostEvent } from './GlyphCommandResultHostEvent.ts';
import type { GlyphErrorHostEvent } from './GlyphErrorHostEvent.ts';
import type { GlyphDesktopSnapshot } from './GlyphDesktopSnapshot.ts';
import type { GlyphChatSummary } from './GlyphChatSummary.ts';
import type { GlyphResponseDelta } from './GlyphResponseDelta.ts';
import type { GlyphToolActivity } from './GlyphToolActivity.ts';
import type { GlyphProposalSummary } from './GlyphProposalSummary.ts';
import type { GlyphQuestionRequest } from './GlyphQuestionRequest.ts';
import type { GlyphApprovalRequest } from './GlyphApprovalRequest.ts';
import type { GlyphUsage } from './GlyphUsage.ts';
import type { GlyphRunProjection } from './GlyphRunProjection.ts';

/** Discriminants for host events projected into a workbench window. */
export enum GlyphHostEventType {
  COMMAND_RESULT = 'command_result',
  INITIAL_STATE = 'initial_state',
  CHAT_UPDATED = 'chat_updated',
  RESPONSE_DELTA = 'response_delta',
  TOOL_ACTIVITY = 'tool_activity',
  PROPOSAL_CHANGED = 'proposal_changed',
  QUESTION = 'question',
  APPROVAL = 'approval',
  USAGE = 'usage',
  RUN_STATE = 'run_state',
  HOST_STATUS = 'host_status',
  ERROR = 'error',
}

/** Closed event union used to keep every host-to-renderer transition exhaustively typed. */
export type GlyphHostEvent =
  | GlyphCommandResultHostEvent
  | { readonly type: GlyphHostEventType.INITIAL_STATE; readonly state: GlyphDesktopSnapshot }
  | { readonly type: GlyphHostEventType.CHAT_UPDATED; readonly chat: GlyphChatSummary }
  | {
      readonly type: GlyphHostEventType.RESPONSE_DELTA;
      readonly chatId: string;
      readonly runId: string;
      readonly delta: GlyphResponseDelta;
    }
  | {
      readonly type: GlyphHostEventType.TOOL_ACTIVITY;
      readonly chatId: string;
      readonly runId: string;
      readonly activity: GlyphToolActivity;
    }
  | {
      readonly type: GlyphHostEventType.PROPOSAL_CHANGED;
      readonly chatId: string;
      readonly proposal: GlyphProposalSummary;
    }
  | {
      readonly type: GlyphHostEventType.QUESTION;
      readonly chatId: string;
      readonly runId: string;
      readonly question: GlyphQuestionRequest;
    }
  | {
      readonly type: GlyphHostEventType.APPROVAL;
      readonly chatId: string;
      readonly runId: string;
      readonly approval: GlyphApprovalRequest;
    }
  | { readonly type: GlyphHostEventType.USAGE; readonly chatId: string; readonly usage: GlyphUsage }
  | { readonly type: GlyphHostEventType.RUN_STATE; readonly run: GlyphRunProjection }
  | {
      readonly type: GlyphHostEventType.HOST_STATUS;
      readonly status: GlyphHostStatus;
      readonly message?: string;
    }
  | GlyphErrorHostEvent;
