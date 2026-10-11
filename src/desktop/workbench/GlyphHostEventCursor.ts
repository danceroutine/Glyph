import type { GlyphHostEventEnvelope } from '#src/desktop/protocol/events/GlyphHostEventEnvelope.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';

/** Outcomes keep transport recovery separate from applying a conversation delta. */
export enum GlyphHostEventDisposition {
  APPLY = 'apply',
  DUPLICATE = 'duplicate',
  RECOVER = 'recover',
}

/**
 * Tracks only events applied to the current in-memory projection. Persisting a
 * cursor without that projection would make a fresh renderer skip its history.
 */
export class GlyphHostEventCursor {
  private generation: string | undefined;
  private sequence = 0;
  private hydrated = false;

  get watermark(): number {
    return this.sequence;
  }

  /** A different utility process cannot replay the old process's journal. */
  bind(hostGeneration: string): void {
    if (this.generation === hostGeneration) return;
    this.generation = hostGeneration;
    this.sequence = 0;
    this.hydrated = false;
  }

  get resume(): { readonly resumeHostGeneration: string; readonly resumeAfterSequence: number } | undefined {
    if (!this.hydrated || !this.generation) return undefined;
    return { resumeHostGeneration: this.generation, resumeAfterSequence: this.sequence };
  }

  /** Never advance past a gap: the missing delta must be replayed or replaced by a snapshot. */
  accept(envelope: GlyphHostEventEnvelope): GlyphHostEventDisposition {
    if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) return GlyphHostEventDisposition.RECOVER;
    const sameGeneration = this.generation === envelope.hostGeneration;
    if (sameGeneration && envelope.sequence <= this.sequence) return GlyphHostEventDisposition.DUPLICATE;
    if (envelope.event.type === GlyphHostEventType.INITIAL_STATE) {
      this.generation = envelope.hostGeneration;
      this.sequence = envelope.sequence;
      this.hydrated = true;
      return GlyphHostEventDisposition.APPLY;
    }
    if (!sameGeneration || !this.hydrated || envelope.sequence !== this.sequence + 1)
      return GlyphHostEventDisposition.RECOVER;
    this.sequence = envelope.sequence;
    return GlyphHostEventDisposition.APPLY;
  }
}
