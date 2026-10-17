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
  readonly composer: GlyphComposerState;
  send(text: string): Promise<void>;
  cancel(): void;
  writeShellInput(chatId: string, sessionId: string, input: string, appendNewline: boolean): Promise<void>;
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
  openChat(chatId: string): Promise<void>;
  selectAccount(provider: string, accountId: string): Promise<void>;
  selectModel(model: string): Promise<void>;
}

export type GlyphWorkbenchMount = (
  container: HTMLElement,
  state: GlyphWorkbenchState,
  actions: GlyphWorkbenchViewActions,
) => GlyphWorkbenchView;
