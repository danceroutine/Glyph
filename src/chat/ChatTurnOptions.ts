import type { AgentModeID } from './AgentMode.ts';

/** A comment carries its captured quote, not a live read of its source. Offsets are UTF-16. */
export interface ChatAnnotation {
  readonly id: string;
  readonly order: number;
  readonly kind: 'chat' | 'plan' | 'proposal';
  readonly sourceId: string;
  readonly revision: string;
  readonly label: string;
  readonly quote: string;
  readonly from: number;
  readonly to: number;
  readonly comment: string;
}
export interface ChatTurnOptions {
  /** UTF-16 spans in the trimmed prompt, in attachment order. */
  readonly attachmentSpans?: readonly { readonly from: number; readonly to: number }[];
  readonly turnId?: string;
  /** Legacy chat-based review metadata, retained for saved transcript compatibility. */
  readonly agentReviewId?: string;
  readonly mode?: AgentModeID;
  readonly annotations?: readonly ChatAnnotation[];
  readonly planBuild?: ChatPlanBuildOrder;
  readonly planProgress?: ChatPlanProgress;
  /** Positions and identities of user-selected slash references in the trimmed prompt. */
  readonly referenceSpans?: readonly ChatReferenceSpan[];
  /** Stable IDs of manual rules explicitly selected by the user for this turn. */
  readonly manualRuleIds?: readonly string[];
  /** Stable identities of skills explicitly selected from the slash picker. */
  readonly skillIds?: readonly string[];
}

/** UTF-16 position and display metadata sufficient to restore an editable selection. */
export interface ChatReferenceSpan {
  readonly kind: 'rule';
  readonly sourceId: string;
  readonly label: string;
  readonly revision: string;
  readonly from: number;
  readonly to: number;
}

export interface ChatPlanBuildOrder {
  readonly planId: string;
  readonly revision: number;
  readonly title: string;
  readonly sourceChatId: string;
  readonly todos: readonly { readonly id: string; readonly text: string; readonly completed: boolean }[];
}

export interface ChatPlanProgress {
  readonly planId: string;
  readonly title: string;
  readonly current?: string;
  readonly completed: number;
  readonly total: number;
}
