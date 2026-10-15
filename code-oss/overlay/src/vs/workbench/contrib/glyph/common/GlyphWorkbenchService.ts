import { Event } from '#vs/base/common/event.js';
import { createDecorator } from '#vs/platform/instantiation/common/instantiation.js';
import type { GlyphWorkbenchSelection } from '#glyph/workbench/GlyphWorkbenchSelection.js';
import type { GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';
import type { GlyphComposerState } from '#glyph/workbench/GlyphComposerState.js';

export const GlyphWorkbenchService = createDecorator<GlyphWorkbenchService>('glyphWorkbenchService');

/** Workbench interaction port implemented by the native host-backed adapter. */
export interface GlyphWorkbenchService {
  readonly composer: GlyphComposerState;
  readonly _serviceBrand: undefined;
  readonly onDidChangeState: Event<GlyphWorkbenchState>;
  readonly state: GlyphWorkbenchState;
  send(text: string): Promise<void>;
  cancel(): void;
  newChat(): void;
  setSelection(selection: GlyphWorkbenchSelection | undefined): void;
  connect(): Promise<void>;
  selectAccount(provider: string, accountId: string): Promise<void>;
  selectModel(model: string): Promise<void>;
  createChat(provider: string, accountId: string, model: string): Promise<void>;
  openChat(chatId: string): Promise<void>;
  answerQuestion(chatId: string, runId: string, questionId: string, answer: unknown): Promise<void>;
  decideApproval(chatId: string, runId: string, approvalId: string, approved: boolean): Promise<void>;
  acceptProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void>;
  rejectProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void>;
}
