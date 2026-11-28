import type { ChatResponsePart } from './ChatResponsePart.ts';

/**
 * Host-neutral response port. A terminal can print these parts, while a VS Code
 * adapter can translate them to ChatResponseStream or LanguageModelResponsePart.
 */
export interface ChatResponseStream {
  /** Called when the provider has admitted the request and is starting its model turn. */
  onTurnAdmitted?: () => void;
  push(part: ChatResponsePart): void;
}
