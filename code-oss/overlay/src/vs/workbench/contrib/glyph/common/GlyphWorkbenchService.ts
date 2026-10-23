import type { AgentReviewInput } from '#vs/platform/glyph/reviewing/AgentReview.js';
import type { GlyphIdeContext } from '#vs/workbench/contrib/glyph/browser/GlyphIdeContext.js';
import type { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
import type { GlyphFollowUpBehavior } from '#glyph/workbench/GlyphFollowUpBehavior.js';
import { AgentModeID } from '#glyph/protocol/index.js';
import type { GlyphTurnOptions } from '#glyph/protocol/events/GlyphAnnotation.js';
import type { GlyphPlanRecord } from '#glyph/protocol/events/GlyphPlanRecord.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphContextActions } from '#glyph/workbench/GlyphContextActions.js';
import type { GlyphApprovalDecision } from '#glyph/protocol/GlyphApprovalDecision.js';
import { Event } from '#vs/base/common/event.js';
import { createDecorator } from '#vs/platform/instantiation/common/instantiation.js';
import type { GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';
import type { GlyphComposerState } from '#glyph/workbench/GlyphComposerState.js';

export const GlyphWorkbenchService = createDecorator<GlyphWorkbenchService>('glyphWorkbenchService');

/** Workbench interaction port implemented by the native host-backed adapter. */
export interface GlyphWorkbenchService {
  readonly ideContext: GlyphIdeContext;
  readonly composer: GlyphComposerState;
  readonly _serviceBrand: undefined;
  readonly onDidChangeState: Event<GlyphWorkbenchState>;
  readonly state: GlyphWorkbenchState;
  readonly context: GlyphContextActions;
  attachIdeContext(): Promise<void>;
  attachSelection(): Promise<void>;
  attachExplorerResources(resources: readonly string[], newChat: boolean): Promise<void>;
  send(text: string, attachments?: readonly GlyphContextAttachment[], options?: GlyphTurnOptions): Promise<void>;
  moveQueuedToNewChat(id: string): Promise<void>;
  readonly followUpBehavior: GlyphFollowUpBehavior;
  sendImmediately(
    text: string,
    attachments?: readonly GlyphContextAttachment[],
    options?: GlyphTurnOptions,
  ): Promise<void>;
  steer(text: string, attachments?: readonly GlyphContextAttachment[], options?: GlyphTurnOptions): Promise<void>;
  selectMode?(mode: AgentModeID): Promise<void>;
  buildPlan?(chatId: string, plan: GlyphPlanRecord, newChat?: boolean): Promise<void>;
  stopPlanBuild?(chatId: string, planId: string): Promise<void>;
  branchChat?(chatId: string, turnId: string): Promise<void>;
  restoreCheckpoint?(chatId: string, turnId: string): Promise<void>;
  copyText(text: string): Promise<void>;
  openLink?(href: string): Promise<void>;
  viewPlan?(chatId: string, plan: GlyphPlanRecord): Promise<void>;
  cancel(): void;
  startAgentReview(review: AgentReviewInput): Promise<void>;
  cancelAgentReview(reviewId: string): Promise<void>;
  dismissAgentReviewFinding(reviewId: string, findingId: string): Promise<void>;
  cancelRun(chatId: string, runId: string): Promise<void>;
  executeReviewCommand(command: GlyphReviewCommand): void;
  reviewProposalFile(chatId: string, proposalId: string, fileId: string): Promise<void>;
  decideProposalItems(
    chatId: string,
    items: readonly { readonly proposalId: string; readonly itemId: string }[],
    accept: boolean,
  ): Promise<void>;
  newChat(): void;
  closeChat(chatId: string): Promise<void>;
  setChatArchived(chatId: string, archived: boolean): Promise<void>;
  setChatPinned(chatId: string, pinned: boolean): void;
  connect(): Promise<void>;
  selectAccount(provider: string, accountId: string): Promise<void>;
  selectModel(model: string): Promise<void>;
  createChat(provider: string, accountId: string, model: string): Promise<void>;
  openChat(chatId: string): Promise<void>;
  writeShellInput(chatId: string, sessionId: string, input: string, appendNewline: boolean): Promise<void>;
  openShell(chatId: string, sessionId: string): Promise<void>;
  stopShell(chatId: string, sessionId: string): Promise<void>;
  pauseGoal(chatId: string, goalId: string): Promise<void>;
  resumeGoal(chatId: string, goalId: string): Promise<void>;
  clearGoal(chatId: string, goalId: string): Promise<void>;
  answerQuestion(chatId: string, runId: string, questionId: string, answer: unknown): Promise<void>;
  decideApproval(chatId: string, runId: string, approvalId: string, decision: GlyphApprovalDecision): Promise<void>;
  acceptProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void>;
  rejectProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void>;
}
