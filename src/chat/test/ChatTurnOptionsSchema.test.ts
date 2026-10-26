import { describe, expect, it } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { annotationSchema, chatTurnOptionsSchema } from '#src/chat/ChatTurnOptionsSchema.js';

describe('chatTurnOptionsSchema', () => {
  it('keeps every supplied option', () => {
    const annotation = {
      id: 'note',
      order: 1,
      kind: 'chat' as const,
      sourceId: 'source',
      revision: 'revision',
      label: 'Label',
      quote: 'abc',
      from: 0,
      to: 3,
      comment: 'Check this.',
    };

    expect(
      chatTurnOptionsSchema.parse({
        attachmentSpans: [{ from: 0, to: 2 }],
        turnId: 'turn-1',
        agentReviewId: '00000000-0000-4000-8000-000000000000',
        mode: AgentModeID.PLAN,
        annotations: [annotation],
        manualRuleIds: ['rule', 'rule'],
      }),
    ).toEqual({
      attachmentSpans: [{ from: 0, to: 2 }],
      turnId: 'turn-1',
      agentReviewId: '00000000-0000-4000-8000-000000000000',
      mode: AgentModeID.PLAN,
      annotations: [annotation],
      manualRuleIds: ['rule'],
    });
  });

  it('omits absent options', () => {
    expect(chatTurnOptionsSchema.parse({})).toEqual({});
    expect(chatTurnOptionsSchema.parse({ manualRuleIds: [] })).toEqual({});
  });

  it('rejects empty attachment spans', () => {
    expect(() => chatTurnOptionsSchema.parse({ attachmentSpans: [{ from: 2, to: 2 }] })).toThrow();
  });
});

describe('annotationSchema', () => {
  it('rejects quotes that do not match their captured range', () => {
    expect(() =>
      annotationSchema.parse({
        id: 'note',
        order: 1,
        kind: 'plan',
        sourceId: 'source',
        revision: 'revision',
        label: '',
        quote: 'abc',
        from: 0,
        to: 5,
        comment: 'Mismatch.',
      }),
    ).toThrow('The quote must match the captured range.');
  });
});
