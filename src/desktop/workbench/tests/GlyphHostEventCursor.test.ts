import { describe, expect, it } from 'vitest';
import { GlyphHostEventCursor, GlyphHostEventDisposition } from '#src/desktop/workbench/GlyphHostEventCursor.js';
import { GlyphWorkbenchProjection } from '#src/desktop/workbench/GlyphWorkbenchProjection.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphHostEventEnvelope } from '#src/desktop/protocol/events/GlyphHostEventEnvelope.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';

const delta: GlyphHostEvent = {
  type: GlyphHostEventType.RESPONSE_DELTA,
  chatId: 'chat',
  runId: 'run',
  delta: { kind: GlyphResponseDeltaKind.TEXT, value: 'hello' },
};
const snapshot: GlyphHostEvent = {
  type: GlyphHostEventType.INITIAL_STATE,
  state: {
    accounts: [],
    models: [],
    chats: [],
    runs: [],
    proposals: [],
    ownerWindowId: 'window',
    readOnly: false,
    sequence: 1,
  },
};

describe(GlyphHostEventCursor, () => {
  it('reconstructs the same answer when a missing delta is replayed and a later delta arrives twice', () => {
    const cursor = new GlyphHostEventCursor();
    const projection = new GlyphWorkbenchProjection();
    const deliveries = [
      envelope(1, snapshot),
      envelope(2, delta),
      envelope(4, delta),
      envelope(3, delta),
      envelope(4, delta),
      envelope(4, delta),
    ];
    for (const delivery of deliveries) {
      if (cursor.accept(delivery) === GlyphHostEventDisposition.APPLY) projection.accept(delivery.event);
    }
    expect(projection.state.runs).toHaveLength(1);
    expect(projection.state.runs[0]?.text).toBe('hellohellohello');
    expect(cursor.watermark).toBe(4);
  });

  it('requires a fresh renderer to receive a snapshot before applying streamed text', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.bind('host');
    expect(cursor.resume).toBeUndefined();
    expect(cursor.accept(envelope(1, delta))).toBe(GlyphHostEventDisposition.RECOVER);
    expect(cursor.watermark).toBe(0);
    expect(cursor.accept(envelope(70, snapshot))).toBe(GlyphHostEventDisposition.APPLY);
    expect(cursor.resume).toEqual({ resumeHostGeneration: 'host', resumeAfterSequence: 70 });
  });

  it('applies each ordered event once and ignores repeated deltas and older snapshots', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.accept(envelope(10, snapshot));
    expect(cursor.accept(envelope(11, delta))).toBe(GlyphHostEventDisposition.APPLY);
    expect(cursor.accept(envelope(11, delta))).toBe(GlyphHostEventDisposition.DUPLICATE);
    expect(cursor.accept(envelope(10, snapshot))).toBe(GlyphHostEventDisposition.DUPLICATE);
    expect(cursor.watermark).toBe(11);
  });

  it('keeps its last applied sequence at a gap and accepts missing events when replay fills it', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.accept(envelope(10, snapshot));
    expect(cursor.accept(envelope(13, delta))).toBe(GlyphHostEventDisposition.RECOVER);
    expect(cursor.watermark).toBe(10);
    for (const sequence of [11, 12, 13])
      expect(cursor.accept(envelope(sequence, delta))).toBe(GlyphHostEventDisposition.APPLY);
    expect(cursor.accept(envelope(13, delta))).toBe(GlyphHostEventDisposition.DUPLICATE);
  });

  it('resumes after an authoritative snapshot when the missing history cannot be replayed', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.accept(envelope(1, snapshot));
    expect(cursor.accept(envelope(600, delta))).toBe(GlyphHostEventDisposition.RECOVER);
    expect(cursor.accept(envelope(601, snapshot))).toBe(GlyphHostEventDisposition.APPLY);
    expect(cursor.accept(envelope(602, delta))).toBe(GlyphHostEventDisposition.APPLY);
  });

  it('retains its replay position when reconnecting to the same host with the existing projection', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.accept(envelope(10, snapshot));
    cursor.bind('host');
    expect(cursor.resume).toEqual({ resumeHostGeneration: 'host', resumeAfterSequence: 10 });
  });

  it('requires a new snapshot after connecting to a different host generation', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.accept(envelope(100, snapshot));
    cursor.bind('restarted');
    expect(cursor.resume).toBeUndefined();
    expect(cursor.accept(envelope(1, delta, 'restarted'))).toBe(GlyphHostEventDisposition.RECOVER);
    expect(cursor.accept(envelope(2, snapshot, 'restarted'))).toBe(GlyphHostEventDisposition.APPLY);
    expect(cursor.resume).toEqual({ resumeHostGeneration: 'restarted', resumeAfterSequence: 2 });
  });

  it('does not confuse a new host’s low sequence with an old duplicate', () => {
    const cursor = new GlyphHostEventCursor();
    cursor.accept(envelope(100, snapshot));
    expect(cursor.accept(envelope(1, delta, 'restarted'))).toBe(GlyphHostEventDisposition.RECOVER);
    expect(cursor.watermark).toBe(100);
    expect(cursor.accept(envelope(2, snapshot, 'restarted'))).toBe(GlyphHostEventDisposition.APPLY);
    expect(cursor.watermark).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid sequence %s without advancing the projection',
    sequence => {
      const cursor = new GlyphHostEventCursor();
      expect(cursor.accept(envelope(sequence, snapshot))).toBe(GlyphHostEventDisposition.RECOVER);
      expect(cursor.resume).toBeUndefined();
    },
  );
});

function envelope(sequence: number, event: GlyphHostEvent, hostGeneration = 'host'): GlyphHostEventEnvelope {
  return {
    profileId: 'profile',
    windowId: 'window',
    workspaceId: 'workspace',
    protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
    hostGeneration,
    sequence,
    event,
  };
}
