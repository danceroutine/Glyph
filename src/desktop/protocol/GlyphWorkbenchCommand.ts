import type { GlyphApprovalDecision } from './GlyphApprovalDecision.ts';
import type { GlyphWorkspaceRoot } from './connection/GlyphWorkspaceRoot.ts';
import type { GlyphContextAttachment } from './connection/GlyphContextAttachment.ts';

/** Discriminants for commands sent from the workbench to the utility host. */
export enum GlyphWorkbenchCommandType {
  ATTACH_WORKSPACE = 'attach_workspace',
  LIST_CHATS = 'list_chats',
  CREATE_CHAT = 'create_chat',
  OPEN_CHAT = 'open_chat',
  SELECT_ACCOUNT = 'select_account',
  SELECT_MODEL = 'select_model',
  SEND = 'send',
  CANCEL_RUN = 'cancel_run',
  ANSWER_QUESTION = 'answer_question',
  DECIDE_APPROVAL = 'decide_approval',
  READ_PROPOSAL_FILE = 'read_proposal_file',
  ACCEPT_PROPOSAL_ITEM = 'accept_proposal_item',
  REJECT_PROPOSAL_ITEM = 'reject_proposal_item',
  WRITE_SHELL_INPUT = 'write_shell_input',
  STOP_SHELL_SESSION = 'stop_shell_session',
  REQUEST_SNAPSHOT = 'request_snapshot',
  DETACH = 'detach',
}

/**
 * Closed command union. Each member remains plain data so it can be transferred
 * through MessagePort without coupling either process to the other's classes.
 */
export type GlyphWorkbenchCommand =
  | {
      readonly type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE;
      readonly roots: readonly GlyphWorkspaceRoot[];
      readonly trusted: boolean;
      readonly resumeHostGeneration?: string;
      readonly resumeAfterSequence?: number;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.LIST_CHATS;
      readonly accountProvider?: string;
      readonly accountId?: string;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.CREATE_CHAT;
      readonly creationId?: string;
      readonly accountProvider: string;
      readonly accountId: string;
      readonly model: string;
    }
  | { readonly type: GlyphWorkbenchCommandType.OPEN_CHAT; readonly chatId: string }
  | {
      readonly type: GlyphWorkbenchCommandType.SELECT_ACCOUNT;
      readonly accountProvider: string;
      readonly accountId: string;
    }
  | { readonly type: GlyphWorkbenchCommandType.SELECT_MODEL; readonly model: string }
  | {
      readonly type: GlyphWorkbenchCommandType.SEND;
      readonly chatId: string;
      readonly runId: string;
      readonly text: string;
      readonly attachments: readonly GlyphContextAttachment[];
    }
  | { readonly type: GlyphWorkbenchCommandType.CANCEL_RUN; readonly chatId: string; readonly runId: string }
  | {
      readonly type: GlyphWorkbenchCommandType.ANSWER_QUESTION;
      readonly chatId: string;
      readonly runId: string;
      readonly questionId: string;
      readonly answer: unknown;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.DECIDE_APPROVAL;
      readonly chatId: string;
      readonly runId: string;
      readonly approvalId: string;
      readonly decision: GlyphApprovalDecision;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.READ_PROPOSAL_FILE;
      readonly chatId: string;
      readonly proposalId: string;
      readonly fileId: string;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM;
      readonly chatId: string;
      readonly proposalId: string;
      readonly itemId: string;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM;
      readonly comment?: string;
      readonly chatId: string;
      readonly proposalId: string;
      readonly itemId: string;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.STOP_SHELL_SESSION;
      readonly chatId: string;
      readonly sessionId: string;
    }
  | {
      readonly type: GlyphWorkbenchCommandType.WRITE_SHELL_INPUT;
      readonly chatId: string;
      readonly sessionId: string;
      readonly input: string;
      readonly appendNewline: boolean;
    }
  | { readonly type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT; readonly afterSequence: number }
  | { readonly type: GlyphWorkbenchCommandType.DETACH };
