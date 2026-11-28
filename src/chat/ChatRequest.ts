import type { WorkspaceDisclosure } from '#src/workspace/WorkspaceDisclosure.js';
import type { ChatTurnOptions } from '#src/chat/ChatTurnOptions.js';
import type { ContextAttachment } from '#src/context/attachments/ContextAttachment.js';

/**
 * Provider-neutral input for one user turn. Attachments are exact workspace
 * snapshots resolved by the application immediately before inference.
 */
export interface ChatRequest extends ChatTurnOptions {
  /** In-memory admission for this turn, including scopes contributed by a Git comparison. */
  readonly disclosure?: WorkspaceDisclosure;
  readonly text: string;
  readonly attachments: readonly ContextAttachment[];
}

/** Convenience input retained for hosts that do not support attachments. */
export type ChatRequestInput = ChatRequest | string;

export function toChatRequest(input: ChatRequestInput): ChatRequest {
  return typeof input === 'string' ? { text: input, attachments: [] } : input;
}
