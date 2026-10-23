import type { AgentModeID } from '#src/chat/AgentMode.js';

export enum GlyphModeSwapStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  DENIED = 'denied',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export interface GlyphModeSwap {
  readonly id: string;
  readonly source: AgentModeID;
  readonly target: AgentModeID;
  readonly description: string;
  readonly status: GlyphModeSwapStatus;
  /** Absent only in histories saved before countdown bars were introduced. */
  readonly startedAt?: string;
  readonly expiresAt: string;
  readonly autoApprove: boolean;
}
export interface GlyphModeSwapPolicy {
  readonly autoApprove: boolean;
  readonly timeoutSeconds: number;
}
