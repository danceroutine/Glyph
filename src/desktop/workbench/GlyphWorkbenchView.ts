import type { GlyphFollowUpBehavior } from './GlyphFollowUpBehavior.ts';
import type { GlyphComposerCommand } from './GlyphComposerCommand.ts';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { GlyphContextActions } from './GlyphContextActions.ts';
import type { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { GlyphWorkbenchState } from './GlyphWorkbenchState.ts';
import type { GlyphComposerState } from './GlyphComposerState.ts';

/** Keeps the workbench lifecycle independent of the component renderer. */
export interface GlyphWorkbenchView {
  update(state: GlyphWorkbenchState): void;
  dispose(): void;
}

/** Callbacks preserve the service's ownership of application behavior. */
export interface GlyphWorkbenchViewActions {
  reconnectWorkspace?(): Promise<void>;
  readonly fileIconClasses?: (path: string) => readonly string[];
  readonly composer: GlyphComposerState;
  readonly context: GlyphContextActions;
  /** Adds room for history alongside the chat; cleanup releases only the added width. */
  reserveHistoryWidth?(width: number): () => void;
  send(text: string, attachments?: readonly GlyphContextAttachment[], options?: GlyphTurnOptions): Promise<void>;
  /** Native hosts resolve shortcuts through the workbench; browser previews use editor defaults. */
  readonly composerKeybindings?: {
    mount(element: HTMLElement): () => void;
    dispatch(event: KeyboardEvent): boolean;
    label(command: GlyphComposerCommand): string | undefined;
  };
  readonly followUpBehavior?: GlyphFollowUpBehavior;
  /** Native hosts drain queued drafts even while their pane is unmounted. */
  readonly managesQueue?: boolean;
  moveQueuedToNewChat?(id: string): Promise<void>;
  openMessageSettings?(): void;
  sendImmediately?(
    text: string,
    attachments?: readonly GlyphContextAttachment[],
    options?: GlyphTurnOptions,
  ): Promise<void>;
  steer?(text: string, attachments?: readonly GlyphContextAttachment[], options?: GlyphTurnOptions): Promise<void>;
  selectMode?(mode: AgentModeID): Promise<void>;
  buildPlan?(chatId: string, plan: GlyphPlan, newChat?: boolean): Promise<void>;
  viewPlan?(chatId: string, plan: GlyphPlan): Promise<void>;
  branchChat?(chatId: string, turnId: string): Promise<void>;
  restoreCheckpoint?(chatId: string, turnId: string): Promise<void>;
  copyText?(text: string): Promise<void>;
  openLink?(href: string): Promise<void>;
  cancel(): void;
  writeShellInput(chatId: string, sessionId: string, input: string, appendNewline: boolean): Promise<void>;
  openShell?(chatId: string, sessionId: string): Promise<void>;
  stopShell(chatId: string, sessionId: string): Promise<void>;
  answerQuestion(chatId: string, runId: string, questionId: string, answer: unknown): Promise<void>;
  decideApproval(chatId: string, runId: string, approvalId: string, decision: GlyphApprovalDecision): Promise<void>;
  reviewProposalFile(chatId: string, proposalId: string, fileId: string): Promise<void>;
  decideProposalItems(
    chatId: string,
    items: readonly { readonly proposalId: string; readonly itemId: string }[],
    accept: boolean,
  ): Promise<void>;
  newChat(): void;
  closeChat?(chatId: string): Promise<void>;
  setChatArchived?(chatId: string, archived: boolean): Promise<void>;
  setChatPinned?(chatId: string, pinned: boolean): void;
  /** Available native pane actions, rendered by the same header in previews. */
  readonly chatMenuActions?: readonly {
    readonly id: string;
    readonly label: string;
    readonly run: () => void | Promise<void>;
  }[];
  openChat(chatId: string): Promise<void>;
  selectAccount(provider: string, accountId: string): Promise<void>;
  selectModel(model: string): Promise<void>;
}

export type GlyphWorkbenchMount = (
  container: HTMLElement,
  state: GlyphWorkbenchState,
  actions: GlyphWorkbenchViewActions,
) => GlyphWorkbenchView;
