import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphHostEventEnvelope } from '#src/desktop/protocol/events/GlyphHostEventEnvelope.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';

/**
 * Retains a bounded, per-window event history so a renderer reload can resume
 * without forcing the workspace runtime to restart. The host generation makes
 * sequences meaningful only within one utility-host lifetime.
 */
export class HostEventJournal {
  private sequence = 0;
  private retainedBytes = 0;
  private readonly events: { readonly envelope: GlyphHostEventEnvelope; readonly bytes: number }[] = [];

  constructor(
    readonly hostGeneration: string,
    private readonly capacity = 512,
    private readonly byteCapacity = 8 * 1024 * 1024,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Event journal capacity must be positive.');
    if (!Number.isSafeInteger(byteCapacity) || byteCapacity < 1)
      throw new Error('Event journal byte capacity must be positive.');
  }

  /** Highest sequence issued, including events that have aged out of the buffer. */
  get watermark(): number {
    return this.sequence;
  }

  /** Revokes replay from the previous attachment authority while preserving monotonic sequence numbers. */
  discard(): void {
    this.events.length = 0;
    this.retainedBytes = 0;
  }

  /**
   * Stamps each event with the connection's trusted identity and a monotonic
   * sequence. This gives renderers the information needed to discard duplicate
   * deliveries and detect missing events after a disconnect. Retaining the stamped envelope
   * lets replay preserve the original ordering; a new sequence would make an
   * already-applied delta look like fresh text. The host generation prevents
   * sequence numbers from an earlier process being mistaken for current ones.
   */
  append(identity: GlyphConnectionIdentity, event: GlyphHostEvent): GlyphHostEventEnvelope {
    const envelope: GlyphHostEventEnvelope = {
      ...identity,
      protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
      hostGeneration: this.hostGeneration,
      sequence: ++this.sequence,
      event,
    };
    // A reconnecting renderer must request fresh authorization for a captured resource.
    if (event.type === GlyphHostEventType.ATTACHMENT_RESOURCE_RESOLVED) {
      this.discard();
      return envelope;
    }
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (bytes > this.byteCapacity) {
      // The live recipient still receives the complete event. Reconnect uses the current snapshot,
      // which owns the latest preview, rather than retaining superseded package comparisons.
      this.discard();
      return envelope;
    }
    this.events.push({ envelope, bytes });
    this.retainedBytes += bytes;
    while (this.events.length > this.capacity || this.retainedBytes > this.byteCapacity)
      this.retainedBytes -= this.events.shift()!.bytes;
    return envelope;
  }

  /**
   * Returns `undefined` when replay would contain a gap, telling the caller to
   * send a full snapshot instead. An empty array means the renderer is current.
   */
  after(sequence: number): readonly GlyphHostEventEnvelope[] | undefined {
    if (sequence === this.sequence) return [];
    const oldest = this.events[0]?.envelope.sequence ?? this.sequence + 1;
    if (sequence < oldest - 1 || sequence > this.sequence) return undefined;
    return this.events.filter(({ envelope }) => envelope.sequence > sequence).map(({ envelope }) => envelope);
  }
}
