import { AgentModeID } from '#src/chat/AgentMode.js';
/** A comment carries its captured quote, not a live read of its source. Offsets are UTF-16. */
export interface GlyphAnnotation {
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
export interface GlyphTurnOptions {
  /** UTF-16 spans in the trimmed prompt, in attachment order. */
  readonly attachmentSpans?: readonly { readonly from: number; readonly to: number }[];
  readonly turnId?: string;
  /** Associates a structured code review with its originating workbench panel. */
  readonly agentReviewId?: string;
  readonly mode?: AgentModeID;
  readonly annotations?: readonly GlyphAnnotation[];
}
