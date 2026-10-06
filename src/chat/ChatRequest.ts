import type { ContextAttachment } from '../context/attachments/ContextAttachment.ts';

/**
 * Provider-neutral input for one user turn. Attachments are exact workspace
 * snapshots resolved by the application immediately before inference.
 */
export interface ChatRequest {
  readonly text: string;
  readonly attachments: readonly ContextAttachment[];
}

/** Convenience input retained for hosts that do not support attachments. */
export type ChatRequestInput = ChatRequest | string;

export function toChatRequest(input: ChatRequestInput): ChatRequest {
  return typeof input === 'string' ? { text: input, attachments: [] } : input;
}
