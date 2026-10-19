import type { ChatRequest } from './ChatRequest.ts';
import type { GlyphSteeringMessage } from '#src/desktop/protocol/events/GlyphSteeringMessage.js';
import { ProviderError } from '#src/errors/ProviderError.js';

/** Run-owned mailbox, drained only between model steps after tool outcomes settle. */
export class ChatSteeringQueue {
  private pending: ChatRequest[] = [];
  private closed = false;
  private accepted: GlyphSteeringMessage[] = [];
  /** Closing an empty final boundary synchronously prevents late input from being silently lost. */
  take = (finishing: boolean): readonly ChatRequest[] => {
    const requests = this.pending;
    this.pending = [];
    if (finishing && !requests.length) this.close();
    return requests;
  };
  get messages(): readonly GlyphSteeringMessage[] {
    return this.accepted;
  }
  add(request: ChatRequest, message: GlyphSteeringMessage): void {
    if (this.closed) throw new ProviderError('This response has finished. Send the instruction as a new message.');
    if (this.accepted.some(value => value.id === message.id)) return;
    this.pending.push(request);
    this.accepted = [...this.accepted, message];
  }
  close(): void {
    this.closed = true;
  }
}
