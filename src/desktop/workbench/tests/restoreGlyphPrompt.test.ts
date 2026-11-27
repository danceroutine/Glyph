import { describe, expect, it, vi } from 'vitest';
import { restoreGlyphDraftReferences, restoreGlyphPrompt } from '#src/desktop/workbench/restoreGlyphPrompt.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { toGlyphPromptText, type GlyphPromptPart } from '#src/desktop/workbench/GlyphPromptDocument.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { ChatTurnOptions } from '#src/chat/ChatTurnOptions.js';

const rule: GlyphContextAttachment = {
  kind: GlyphContextAttachmentKind.RULE,
  ruleId: 'rule',
  path: 'Use',
  uri: 'glyph-rule:rule',
  text: '',
  contentRevision: 'r1',
};
const file: GlyphContextAttachment = {
  kind: GlyphContextAttachmentKind.FILE,
  path: 'a.ts',
  uri: 'file:///project/a.ts',
  text: 'captured bytes',
  contentRevision: 'file-r1',
  id: 'file',
};

describe(restoreGlyphPrompt, () => {
  it('excludes a malformed rule reference from selected IDs, captured bytes and spans', async () => {
    const composer = new GlyphComposerState();
    const { ruleId: _missing, ...malformed } = rule;
    composer.setDocument({ parts: [{ type: 'attachment', attachment: malformed }], from: 0, to: 0 });
    await composer.submit(async (_text, attachments, options) => {
      expect(attachments).toEqual([]);
      expect(options?.manualRuleIds).toBeUndefined();
      expect(options?.referenceSpans).toBeUndefined();
    });
  });
  it('round-trips interleaved captures, literal mentions and repeated rule badges at trimmed UTF-16 positions', async () => {
    const composer = new GlyphComposerState();
    const parts: GlyphPromptPart[] = [
      { type: 'text', text: '  🪴 /Use then ' },
      { type: 'attachment', attachment: rule },
      { type: 'text', text: ' before ' },
      { type: 'attachment', attachment: file },
      { type: 'text', text: ' and ' },
      { type: 'attachment', attachment: rule },
    ];
    composer.setDocument({ parts, from: 0, to: 0 });
    let captured!: { text: string; attachments: readonly GlyphContextAttachment[]; options: ChatTurnOptions };
    await composer.submit(async (text, attachments, options) => {
      captured = { text: text.trim(), attachments, options: options! };
    });
    expect(captured.attachments).toEqual([file]);
    expect(captured.options.manualRuleIds).toEqual(['rule']);
    expect(
      captured.options.referenceSpans?.map(ref => [
        ref.kind,
        ref.sourceId,
        ref.revision,
        captured.text.slice(ref.from, ref.to),
      ]),
    ).toEqual([
      ['rule', 'rule', 'r1', '/Use'],
      ['rule', 'rule', 'r1', '/Use'],
    ]);
    const resolve = vi.fn();
    const restored = restoreGlyphPrompt(captured, resolve, () => 'badge');
    expect(resolve).not.toHaveBeenCalled();
    expect(restored.parts).toEqual([
      { type: 'text', text: '🪴 /Use then ' },
      { type: 'attachment', attachment: { ...rule, id: 'badge' } },
      { type: 'text', text: ' before ' },
      { type: 'attachment', attachment: file },
      { type: 'text', text: ' and ' },
      { type: 'attachment', attachment: { ...rule, id: 'badge' } },
    ]);
    expect(toGlyphPromptText(restored.parts)).toBe(captured.text);
    composer.restoreDraft(restored);
    // This also exercises a host/draft that retained the original derived options.
    composer.setDocument({
      parts: [{ type: 'text', text: 'Only text /Use' }],
      from: 0,
      to: 0,
      options: captured.options,
    });
    await composer.submit(async (text, attachments, options) => {
      expect(text).toBe('Only text /Use');
      expect(attachments).toEqual([]);
      expect(options?.referenceSpans).toBeUndefined();
      expect(options?.manualRuleIds).toBeUndefined();
      expect(options?.attachmentSpans).toBeUndefined();
    });
  });

  it('keeps rule and skill IDs distinct across editable restores and queued sends', async () => {
    const skill: GlyphContextAttachment = {
      kind: GlyphContextAttachmentKind.SKILL,
      skillId: 'same',
      path: 'Use',
      text: '',
      contentRevision: 's1',
      uri: 'glyph-skill:same',
    };
    const selectedRule = { ...rule, ruleId: 'same', uri: 'glyph-rule:same' };
    const original = new GlyphComposerState();
    original.setDocument({
      parts: [
        { type: 'text', text: 'Literal /Use ' },
        { type: 'attachment', attachment: skill },
        { type: 'text', text: ' before ' },
        { type: 'attachment', attachment: selectedRule },
      ],
      from: 0,
      to: 0,
    });
    let saved!: { text: string; attachments: readonly GlyphContextAttachment[]; options: ChatTurnOptions };
    await original.submit(async (text, attachments, options) => {
      saved = { text, attachments, options: options! };
    });
    expect(saved.attachments).toEqual([]);
    expect(saved.options.referenceSpans?.map(({ kind, sourceId }) => [kind, sourceId])).toEqual([
      ['skill', 'same'],
      ['rule', 'same'],
    ]);
    expect(saved.options).toMatchObject({ skillIds: ['same'], manualRuleIds: ['same'] });
    const restored = restoreGlyphPrompt(saved, vi.fn(), () => 'badge');
    expect(restored.parts[0]).toEqual({ type: 'text', text: 'Literal /Use ' });
    expect(restored.parts[1]).toMatchObject({ type: 'attachment', attachment: skill });
    const composer = new GlyphComposerState();
    composer.restoreDraft({
      ...restored,
      options: saved.options,
      parts: restored.parts.filter(
        part => part.type === 'text' || part.attachment.kind !== GlyphContextAttachmentKind.SKILL,
      ),
    });
    composer.enqueueDraft();
    await composer.sendQueued(composer.snapshot.queued[0]!.id, async (_text, attachments, options) => {
      expect(attachments).toEqual([]);
      expect(options?.skillIds).toBeUndefined();
      expect(options?.manualRuleIds).toEqual(['same']);
      expect(options?.referenceSpans).toHaveLength(1);
      expect(options?.referenceSpans?.[0]?.kind).toBe('rule');
    });
    const legacy = restoreGlyphPrompt(
      { text: 'Use /Use', attachments: [], options: { skillIds: ['same'] } },
      (kind, id) => (kind === 'skill' && id === 'same' ? { name: 'Use', revision: 's1' } : undefined),
      () => 'legacy',
    );
    expect(legacy.parts.at(-1)).toMatchObject({ type: 'attachment', attachment: skill });
  });

  it('restores only selected IDs and appends visible badges for ambiguous or unavailable legacy mentions', () => {
    const text = '/Use /Same /Same /Similar';
    const options: ChatTurnOptions = {
      manualRuleIds: ['rule', 'second', 'third', 'missing'],
      referenceSpans: [{ kind: 'rule', sourceId: 'unselected', label: 'Same', revision: 'fake', from: 5, to: 10 }],
    };
    const document = restoreGlyphPrompt(
      { text, attachments: [], options },
      (_kind, id) =>
        id === 'rule' ? { name: 'Use', revision: 'one' } : id === 'missing' ? undefined : { name: 'Same' },
      () => 'badge',
    );
    expect(
      document.parts.map(part => (part.type === 'text' ? part.text : [part.attachment.ruleId, part.attachment.text])),
    ).toEqual([['rule', ''], ' /Same /Same /Similar', ' ', ['second', ''], ' ', ['third', ''], ' ', ['missing', '']]);
    expect(restoreGlyphPrompt({ text: 'plain', attachments: [] }, vi.fn(), () => 'badge').parts).toEqual([
      { type: 'text', text: 'plain' },
    ]);
  });
  it('keeps a slash within a URL or a longer word as literal legacy text', () => {
    for (const text of ['https://example.test/Use', '/Useful']) {
      const restored = restoreGlyphPrompt(
        { text, attachments: [], options: { manualRuleIds: ['rule'] } },
        () => ({ name: 'Use' }),
        () => 'id',
      );
      expect(restored.parts[0]).toEqual({ type: 'text', text });
      expect(restored.parts.at(-1)).toMatchObject({ type: 'attachment', attachment: { ruleId: 'rule' } });
    }
  });
});

it('restores only exact, ordered and bounded local draft selections', () => {
  const text = '  /Use /Use';
  const valid = { kind: 'rule', sourceId: 'a', label: 'Use', revision: 'rev', from: 2, to: 6 };
  const second = { kind: 'rule', sourceId: 'b', label: 'Use', revision: 'rev2', from: 7, to: 11 };
  const invalid = [
    null,
    {},
    { ...valid, kind: 'file' },
    { ...valid, sourceId: '' },
    { ...valid, sourceId: 'x'.repeat(501) },
    { ...valid, label: 3 },
    { ...valid, revision: null },
    { ...valid, from: '2' },
    { ...valid, from: 0.5 },
    { ...valid, from: -1 },
    { ...valid, to: 5 },
    { ...valid, from: 1, to: 5 },
  ];
  const document = restoreGlyphDraftReferences(text, [...invalid, valid, valid, second], () => 'badge');
  expect(document.parts.map(part => (part.type === 'text' ? part.text : part.attachment.contentRevision))).toEqual([
    '  ',
    'rev',
    ' ',
    'rev2',
  ]);
  for (const corrupt of [undefined, Array.from({ length: 257 }, () => valid)])
    expect(restoreGlyphDraftReferences(text, corrupt, () => 'badge').parts).toEqual([{ type: 'text', text }]);
});
