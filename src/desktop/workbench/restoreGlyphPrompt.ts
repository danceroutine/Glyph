import { isRecord } from '#src/shared/validators/isRecord.js';
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
    readonly attachments: readonly (GlyphContextAttachment & { readonly previousPath?: string })[];
    readonly options?: ChatTurnOptions;
  },
  resolveLegacy: (
    kind: Reference['kind'],
    id: string,
  ) => { readonly name?: string; readonly revision?: string } | undefined,
  createId: () => string,
): GlyphPromptDocument {
  const { attachmentSpans, referenceSpans = [], manualRuleIds = [], ...options } = draft.options ?? {};
  const mentions: GlyphInlineMention<GlyphContextAttachment>[] = draft.attachments.map(
    ({ previousPath, ...capture }, i) => {
      const attachment = { ...capture, id: capture.id ?? createId() };
      const saved = previousPath ? { ...attachment, path: previousPath } : attachment;
      return {
        attachment,
        mention: toGlyphPromptText([{ type: 'attachment', attachment: saved }]),
        span: attachmentSpans?.[i],
      };
    },
  );
  const selected = [...new Set(manualRuleIds)].map(sourceId => ({ kind: 'rule' as const, sourceId }));
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
  return restoreMentions(draft.text, mentions, positioned, options, createId);
}

function restoreMentions(
  text: string,
  mentions: GlyphInlineMention<GlyphContextAttachment>[],
  references: readonly ChatReferenceSpan[],
  options: ChatTurnOptions,
  createId: () => string,
): GlyphPromptDocument {
  for (const ref of references) {
    const mention = `/${ref.label}`;
    const attachment: GlyphContextAttachment = {
      id: createId(),
      kind: GlyphContextAttachmentKind.RULE,
      ruleId: ref.sourceId,
      uri: `glyph-rule:${encodeURIComponent(ref.sourceId)}`,
      path: ref.label,
      text: '',
      contentRevision: ref.revision,
    };
    mentions.push({ attachment, mention, span: ref });
  }
  const parts = placeGlyphMentions(text, mentions);
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

/** Restore only bounded badges whose positions and text agree with the locally saved draft. */
export function restoreGlyphDraftReferences(text: string, saved: unknown, createId: () => string): GlyphPromptDocument {
  const referenceSpans: ChatReferenceSpan[] = [];
  if (Array.isArray(saved) && saved.length <= Math.max(256, Math.floor(text.length / 2))) {
    let end = 0;
    const entries: readonly unknown[] = saved;
    for (const ref of entries) {
      if (
        !isRecord(ref) ||
        ref.kind !== 'rule' ||
        !boundedField(ref.sourceId, 500) ||
        !boundedField(ref.label, 64 * 1024) ||
        !boundedField(ref.revision, 500) ||
        typeof ref.from !== 'number' ||
        !Number.isSafeInteger(ref.from) ||
        ref.from < end ||
        ref.to !== ref.from + ref.label.length + 1 ||
        text.slice(ref.from, ref.to) !== '/' + ref.label
      )
        continue;
      referenceSpans.push({
        kind: ref.kind,
        sourceId: ref.sourceId,
        label: ref.label,
        revision: ref.revision,
        from: ref.from,
        to: ref.to,
      });
      end = ref.to;
    }
  }
  return restoreMentions(text, [], referenceSpans, {}, createId);
}

function boundedField(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}
