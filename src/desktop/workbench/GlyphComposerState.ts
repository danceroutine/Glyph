import type { GlyphAnnotation, GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { replaceGlyphPromptRange, toGlyphPromptText, type GlyphPromptDocument } from './GlyphPromptDocument.ts';
export interface GlyphAnnotationPosition {
  readonly x: number;
  readonly y: number;
}
/** Window-owned drafts outlive panes, including sends that settle after unmount. */
export class GlyphComposerState {
  private modeTouched = false;
  hydrateMode(mode: 'agent' | 'plan'): void {
    if (!this.modeTouched && this.value.document.options?.mode !== mode)
      this.setDocument({ ...this.value.document, options: { ...this.value.document.options, mode } });
  }
  private annotationSequence = 0;
  private readonly annotationReveals = new Map<
    string,
    (annotation: GlyphAnnotation) => Promise<GlyphAnnotationPosition | undefined>
  >();
  registerAnnotationSource(
    id: string,
    reveal: (annotation: GlyphAnnotation) => Promise<GlyphAnnotationPosition | undefined>,
  ): void {
    this.annotationReveals.set(id, reveal);
  }
  async revealAnnotation(annotation: GlyphAnnotation): Promise<GlyphAnnotationPosition | undefined> {
    return this.annotationReveals.get(annotation.sourceId)?.(annotation);
  }
  private documents: readonly GlyphPromptDocument[] = [];
  private value: {
    document: GlyphPromptDocument;
    focus: number;
    editingAnnotation: string | undefined;
    annotationDraft: GlyphAnnotation | undefined;
    draft: string;
    unsent: readonly string[];
    error: string | undefined;
    submitting: boolean;
  } = {
    document: { parts: [], from: 0, to: 0 },
    focus: 0,
    editingAnnotation: undefined,
    annotationDraft: undefined,
    draft: '',
    unsent: [],
    error: undefined,
    submitting: false,
  };
  private readonly listeners = new Set<() => void>();
  get snapshot(): Readonly<typeof this.value> {
    return this.value;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setDraft(draft: string): void {
    this.setDocument({ parts: draft ? [{ type: 'text', text: draft }] : [], from: draft.length, to: draft.length });
  }
  setDocument(document: GlyphPromptDocument): void {
    document = { ...document, options: document.options ?? this.value.document.options ?? {} };
    this.update({ document, draft: toGlyphPromptText(document.parts) });
  }
  requestAnnotation(annotation: GlyphAnnotation): void {
    this.update({ annotationDraft: annotation });
  }
  setMode(mode: 'agent' | 'plan'): void {
    this.modeTouched = true;
    this.setDocument({ ...this.value.document, options: { ...this.value.document.options, mode } });
  }
  saveAnnotation(annotation: GlyphAnnotation): void {
    const document = this.value.document;
    const annotations = document.options?.annotations ?? [];
    if (!annotations.some(value => value.id === annotation.id))
      annotation = { ...annotation, order: ++this.annotationSequence };
    this.setDocument({
      ...document,
      options: {
        ...document.options,
        annotations: annotations.some(value => value.id === annotation.id)
          ? annotations.map(value => (value.id === annotation.id ? annotation : value))
          : [...annotations, annotation],
      },
    });
    this.editAnnotation(undefined);
  }
  removeAnnotation(id: string): void {
    const document = this.value.document;
    this.setDocument({
      ...document,
      options: {
        ...document.options,
        annotations: document.options?.annotations?.filter(value => value.id !== id) ?? [],
      },
    });
    if (this.value.editingAnnotation === id) this.editAnnotation(undefined);
  }
  editAnnotation(id: string | undefined): void {
    this.update({ editingAnnotation: id, annotationDraft: undefined });
  }
  focus(): void {
    this.update({ focus: this.value.focus + 1 });
  }
  insertAttachments(attachments: readonly GlyphContextAttachment[]): void {
    this.setDocument(
      replaceGlyphPromptRange(
        this.value.document,
        attachments.map(attachment => ({ type: 'attachment', attachment })),
      ),
    );
    this.focus();
  }
  replaceAttachment(id: string, attachment?: GlyphContextAttachment): void {
    const document = this.value.document;
    let offset = 0;
    let from = document.from;
    let to = document.to;
    const parts = document.parts.flatMap(part => {
      const start = offset;
      offset += part.type === 'text' ? part.text.length : 1;
      if (part.type !== 'attachment' || part.attachment.id !== id) return [part];
      if (attachment) return [{ type: 'attachment' as const, attachment }];
      if (start < document.from) from--;
      if (start < document.to) to--;
      return [];
    });
    this.setDocument({ ...document, parts, from, to });
  }
  editUnsent(index: number): void {
    const document = this.documents[index];
    if (!document) return;
    const previous = this.value.document;
    this.documents = this.documents.flatMap((value, position) =>
      position !== index ? [value] : previous.parts.length ? [previous] : [],
    );
    this.setDocument(document);
    this.update({ unsent: this.documents.map(value => toGlyphPromptText(value.parts)) });
    this.focus();
  }
  async submit(
    send: (text: string, attachments: readonly GlyphContextAttachment[], options?: GlyphTurnOptions) => Promise<void>,
  ): Promise<void> {
    if (this.value.submitting || !this.value.draft.trim()) return;
    const { document, draft } = this.value;
    const attachments = document.parts.flatMap(part => (part.type === 'attachment' ? [part.attachment] : []));
    this.update({
      draft: '',
      document: { parts: [], from: 0, to: 0, options: { mode: document.options?.mode ?? 'agent' } },
      editingAnnotation: undefined,
      error: undefined,
      submitting: true,
    });
    try {
      let offset = -(draft.length - draft.trimStart().length);
      const attachmentSpans = document.parts.flatMap(part => {
        const from = offset;
        offset += toGlyphPromptText([part]).length;
        return part.type === 'attachment' ? [{ from, to: offset }] : [];
      });
      await send(draft, attachments, { ...document.options, ...(attachmentSpans.length ? { attachmentSpans } : {}) });
    } catch (error) {
      if (this.value.document.parts.length) this.documents = [...this.documents, document];
      else this.setDocument(document);
      this.update({
        unsent: this.documents.map(value => toGlyphPromptText(value.parts)),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.update({ submitting: false });
    }
  }
  private update(change: Partial<typeof this.value>): void {
    this.value = { ...this.value, ...change };
    for (const listener of this.listeners) listener();
  }
}
