import type { ChatResponsePart } from './ChatResponsePart.ts';

/**
 * Host-neutral response port. A terminal can print these parts, while a VS Code
 * adapter can translate them to ChatResponseStream or LanguageModelResponsePart.
 */
export interface ChatResponseStream {
  push(part: ChatResponsePart): void;
}
