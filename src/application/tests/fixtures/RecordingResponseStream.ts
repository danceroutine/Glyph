import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import type { ChatResponseStream } from '#src/chat/ChatResponseStream.js';

export class RecordingResponseStream implements ChatResponseStream {
  readonly parts: ChatResponsePart[] = [];
  push(part: ChatResponsePart): void {
    this.parts.push(part);
  }
  get text(): string {
    return this.parts
      .filter(
        (part): part is Extract<ChatResponsePart, { type: ChatResponsePartType.TEXT }> =>
          part.type === ChatResponsePartType.TEXT,
      )
      .map(part => part.value)
      .join('');
  }
}
