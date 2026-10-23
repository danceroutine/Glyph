import type { AgentReviewInput, AgentReviewModel } from '#src/reviewing/AgentReview.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { GlyphModeSwapPolicy } from './events/GlyphModeSwap.ts';
import type { GlyphPlanRecord } from './events/GlyphPlanRecord.ts';
import type { GlyphTurnOptions } from './events/GlyphAnnotation.ts';
import type { GlyphApprovalDecision } from './GlyphApprovalDecision.ts';
import type { GlyphWorkspaceRoot } from './connection/GlyphWorkspaceRoot.ts';
import type { GlyphContextAttachment } from './connection/GlyphContextAttachment.ts';

/** Discriminants for commands sent from the workbench to the utility host. */
export enum GlyphWorkbenchCommandType {
  ATTACH_WORKSPACE = 'attach_workspace',
  LIST_CHATS = 'list_chats',
  CREATE_CHAT = 'create_chat',
  OPEN_CHAT = 'open_chat',
  BRANCH_CHAT = 'branch_chat',
  RESTORE_CHECKPOINT = 'restore_checkpoint',
  SELECT_ACCOUNT = 'select_account',
  SELECT_MODEL = 'select_model',
  START_AGENT_REVIEW = 'start_agent_review',
  CANCEL_AGENT_REVIEW = 'cancel_agent_review',
  DISMISS_AGENT_REVIEW_FINDING = 'dismiss_agent_review_finding',
  SEND = 'send',
  STEER = 'steer',
  UPDATE_PLAN = 'update_plan',
  LINK_PLAN = 'link_plan',
  SET_PLAN_TODO = 'set_plan_todo',
  STOP_PLAN_BUILD = 'stop_plan_build',
  SET_CHAT_MODE = 'set_chat_mode',
  CREATE_GOAL = 'create_goal',
  PAUSE_GOAL = 'pause_goal',
  RESUME_GOAL = 'resume_goal',
  CLEAR_GOAL = 'clear_goal',
  CONTINUE_GOAL = 'continue_goal',
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
      readonly type: GlyphWorkbenchCommandType.START_AGENT_REVIEW;
      readonly review: AgentReviewInput;
      readonly model: AgentReviewModel;
    }
  | { readonly type: GlyphWorkbenchCommandType.CANCEL_AGENT_REVIEW; readonly reviewId: string }
  | {
      readonly type: GlyphWorkbenchCommandType.DISMISS_AGENT_REVIEW_FINDING;
      readonly reviewId: string;
      readonly findingId: string;
    }
  | BranchChatCommand
  | RestoreCheckpointCommand
  | SetChatModeCommand
  | CreateGoalCommand
  | GoalCommand
  | AttachWorkspaceCommand
  | ListChatsCommand
  | CreateChatCommand
  | LinkPlanCommand
  | UpdatePlanCommand
  | SetPlanTodoCommand
  | StopPlanBuildCommand
  | OpenChatCommand
  | SelectAccountCommand
  | SelectModelCommand
  | SteerCommand
  | SendCommand
  | CancelRunCommand
  | AnswerQuestionCommand
  | DecideApprovalCommand
  | ReadProposalFileCommand
  | AcceptProposalItemCommand
  | RejectProposalItemCommand
  | StopShellSessionCommand
  | WriteShellInputCommand
  | RequestSnapshotCommand
  | DetachCommand;

type BranchChatCommand = {
  readonly type: GlyphWorkbenchCommandType.BRANCH_CHAT;
  readonly chatId: string;
  readonly turnId: string;
  readonly creationId: string;
};

type RestoreCheckpointCommand = {
  readonly type: GlyphWorkbenchCommandType.RESTORE_CHECKPOINT;
  readonly chatId: string;
  readonly turnId: string;
};

type SetChatModeCommand = {
  readonly type: GlyphWorkbenchCommandType.SET_CHAT_MODE;
  readonly chatId: string;
  readonly mode: AgentModeID;
};

type CreateGoalCommand = {
  readonly type: GlyphWorkbenchCommandType.CREATE_GOAL;
  readonly chatId: string;
  readonly objective: string;
};

type GoalCommand = {
  readonly type:
    | GlyphWorkbenchCommandType.PAUSE_GOAL
    | GlyphWorkbenchCommandType.RESUME_GOAL
    | GlyphWorkbenchCommandType.CLEAR_GOAL
    | GlyphWorkbenchCommandType.CONTINUE_GOAL;
  readonly chatId: string;
  readonly goalId: string;
};

type AttachWorkspaceCommand = {
  readonly type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE;
  readonly roots: readonly GlyphWorkspaceRoot[];
  readonly trusted: boolean;
  readonly resumeHostGeneration?: string;
  readonly resumeAfterSequence?: number;
};

type ListChatsCommand = {
  readonly type: GlyphWorkbenchCommandType.LIST_CHATS;
  readonly accountProvider?: string;
  readonly accountId?: string;
};

type CreateChatCommand = {
  readonly type: GlyphWorkbenchCommandType.CREATE_CHAT;
  readonly creationId?: string;
  readonly accountProvider: string;
  readonly accountId: string;
  readonly model: string;
};

type LinkPlanCommand = {
  readonly type: GlyphWorkbenchCommandType.LINK_PLAN;
  readonly chatId: string;
  readonly planId: string;
  readonly targetChatId: string;
  readonly role: 'Builder' | 'Reviewer';
};

type UpdatePlanCommand = {
  readonly type: GlyphWorkbenchCommandType.UPDATE_PLAN;
  readonly chatId: string;
  readonly plan: GlyphPlanRecord;
};

type SetPlanTodoCommand = {
  readonly type: GlyphWorkbenchCommandType.SET_PLAN_TODO;
  readonly chatId: string;
  readonly planId: string;
  readonly todoId: string;
  readonly completed: boolean;
};

type StopPlanBuildCommand = {
  readonly type: GlyphWorkbenchCommandType.STOP_PLAN_BUILD;
  readonly chatId: string;
  readonly planId: string;
};

type OpenChatCommand = { readonly type: GlyphWorkbenchCommandType.OPEN_CHAT; readonly chatId: string };

type SelectAccountCommand = {
  readonly type: GlyphWorkbenchCommandType.SELECT_ACCOUNT;
  readonly accountProvider: string;
  readonly accountId: string;
};

type SelectModelCommand = { readonly type: GlyphWorkbenchCommandType.SELECT_MODEL; readonly model: string };

type SendCommand = {
  readonly type: GlyphWorkbenchCommandType.SEND;
  readonly modeSwapPolicy?: GlyphModeSwapPolicy;
  readonly chatId: string;
  readonly runId: string;
  readonly text: string;
  readonly attachments: readonly GlyphContextAttachment[];
  readonly options?: GlyphTurnOptions;
};

type CancelRunCommand = {
  readonly type: GlyphWorkbenchCommandType.CANCEL_RUN;
  readonly chatId: string;
  readonly runId: string;
};

type AnswerQuestionCommand = {
  readonly type: GlyphWorkbenchCommandType.ANSWER_QUESTION;
  readonly chatId: string;
  readonly runId: string;
  readonly questionId: string;
  readonly answer: unknown;
};

type DecideApprovalCommand = {
  readonly type: GlyphWorkbenchCommandType.DECIDE_APPROVAL;
  readonly chatId: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: GlyphApprovalDecision;
};

type ReadProposalFileCommand = {
  readonly type: GlyphWorkbenchCommandType.READ_PROPOSAL_FILE;
  readonly chatId: string;
  readonly proposalId: string;
  readonly fileId: string;
};

type AcceptProposalItemCommand = {
  readonly type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM;
  readonly chatId: string;
  readonly proposalId: string;
  readonly itemId: string;
};

type RejectProposalItemCommand = {
  readonly type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM;
  readonly comment?: string;
  readonly chatId: string;
  readonly proposalId: string;
  readonly itemId: string;
};

type StopShellSessionCommand = {
  readonly type: GlyphWorkbenchCommandType.STOP_SHELL_SESSION;
  readonly chatId: string;
  readonly sessionId: string;
};

type WriteShellInputCommand = {
  readonly type: GlyphWorkbenchCommandType.WRITE_SHELL_INPUT;
  readonly chatId: string;
  readonly sessionId: string;
  readonly input: string;
  readonly appendNewline: boolean;
};

type RequestSnapshotCommand = {
  readonly type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT;
  readonly afterSequence: number;
};

type DetachCommand = { readonly type: GlyphWorkbenchCommandType.DETACH };

type SteerCommand = {
  readonly type: GlyphWorkbenchCommandType.STEER;
  readonly chatId: string;
  readonly runId: string;
  readonly messageId: string;
  readonly text: string;
  readonly attachments: readonly GlyphContextAttachment[];
  readonly options?: GlyphTurnOptions;
};
