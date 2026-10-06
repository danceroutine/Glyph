import type { ChatResponsePart } from '../../../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../../../chat/ChatResponsePartType.ts';
import type { ChatResponseStream } from '../../../chat/ChatResponseStream.ts';

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
