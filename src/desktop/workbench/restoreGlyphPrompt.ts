import type { ChatReferenceSpan, ChatTurnOptions } from '#src/chat/ChatTurnOptions.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { toGlyphPromptText, type GlyphPromptDocument } from './GlyphPromptDocument.ts';
import { placeGlyphMentions, type GlyphInlineMention } from './toGlyphTranscriptParts.ts';

type Reference = Pick<ChatReferenceSpan, 'kind' | 'sourceId' | 'label' | 'revision'>;

/** Restore captured files and editable slash badges without loading the referenced instruction body. */
export function restoreGlyphPrompt(
  draft: {
    readonly text: string;
    readonly attachments: readonly GlyphContextAttachment[];
    readonly options?: ChatTurnOptions;
  },
  resolveLegacy: (
    kind: Reference['kind'],
    id: string,
  ) => { readonly name?: string; readonly revision?: string } | undefined,
  createId: () => string,
): GlyphPromptDocument {
  const { attachmentSpans, referenceSpans = [], manualRuleIds = [], skillIds = [], ...options } = draft.options ?? {};
  const mentions: GlyphInlineMention<GlyphContextAttachment>[] = draft.attachments.map((capture, i) => {
    const attachment = { ...capture, id: capture.id ?? createId() };
    return { attachment, mention: toGlyphPromptText([{ type: 'attachment', attachment }]), span: attachmentSpans?.[i] };
  });
  const selected = [
    ...[...new Set(manualRuleIds)].map(sourceId => ({ kind: 'rule' as const, sourceId })),
    ...[...new Set(skillIds)].map(sourceId => ({ kind: 'skill' as const, sourceId })),
  ];
  const exact = referenceSpans.filter(ref =>
    selected.some(choice => choice.kind === ref.kind && choice.sourceId === ref.sourceId),
  );
  const legacy = selected
    .filter(choice => !exact.some(ref => ref.kind === choice.kind && ref.sourceId === choice.sourceId))
    .map(choice => {
      const source = resolveLegacy(choice.kind, choice.sourceId);
      return { ...choice, label: source?.name ?? choice.sourceId, revision: source?.revision ?? choice.sourceId };
    });
  const references = [...exact, ...legacy];
  const positioned = [
    ...exact,
    ...legacy.map(ref => ({ ...ref, ...legacyPosition(draft.text, `/${ref.label}`, references) })),
  ];
  for (const ref of positioned) {
    const mention = `/${ref.label}`;
    const attachment: GlyphContextAttachment = {
      id: createId(),
      ...(ref.kind === 'rule'
        ? { kind: GlyphContextAttachmentKind.RULE, ruleId: ref.sourceId }
        : { kind: GlyphContextAttachmentKind.SKILL, skillId: ref.sourceId }),
      uri: `glyph-${ref.kind}:${encodeURIComponent(ref.sourceId)}`,
      path: ref.label,
      text: '',
      contentRevision: ref.revision,
    };
    mentions.push({ attachment, mention, span: ref });
  }
  const parts = placeGlyphMentions(draft.text, mentions);
  const end = parts.reduce((size, part) => size + (part.type === 'text' ? part.text.length : 1), 0);
  return { parts, from: end, to: end, options };
}

function legacyPosition(text: string, mention: string, references: readonly Reference[]) {
  const from = text.indexOf(mention);
  const end = from + mention.length;
  const unique =
    from >= 0 &&
    text.lastIndexOf(mention) === from &&
    (from === 0 || /\s/u.test(text[from - 1]!)) &&
    (end === text.length || /\s/u.test(text[end]!)) &&
    references.filter(ref => `/${ref.label}` === mention).length === 1;
  return { from: unique ? from : -1, to: unique ? from + mention.length : -1 };
}
