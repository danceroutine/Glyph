import type { ChatRequest } from './ChatRequest.ts';
import type { GlyphSteeringMessage } from '#src/desktop/protocol/events/GlyphSteeringMessage.js';
import { ProviderError } from '#src/errors/ProviderError.js';

/** Run-owned mailbox, drained only between model steps after tool outcomes settle. */
export class ChatSteeringQueue {
  private pending: ChatRequest[] = [];
  private closed = false;
  private accepted: GlyphSteeringMessage[] = [];
  private readonly messageIds = new WeakMap<ChatRequest, string>();
  /** Closing an empty final boundary synchronously prevents late input from being silently lost. */
  take = (finishing: boolean): readonly ChatRequest[] => {
    const requests = this.pending;
    this.pending = [];
    if (finishing && requests.length === 0) this.close();
    return requests;
  };
  get messages(): readonly GlyphSteeringMessage[] {
    return this.accepted;
  }
  add(request: ChatRequest, message: GlyphSteeringMessage): void {
    if (this.closed) throw new ProviderError('This response has finished. Send the instruction as a new message.');
    if (this.accepted.some(value => value.id === message.id)) return;
    this.pending.push(request);
    this.messageIds.set(request, message.id);
    this.accepted = [...this.accepted, message];
  }
  /** Records failed admission against the original user message for live and restored transcripts. */
  reject(request: ChatRequest, message: string): void {
    const id = this.messageIds.get(request);
    this.accepted = this.accepted.map(value => (value.id === id ? { ...value, rejection: message } : value));
  }
  close(): void {
    this.closed = true;
  }
}
