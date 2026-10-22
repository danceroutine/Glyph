import type { GlyphComposerCommand } from './GlyphComposerCommand.ts';
import { AgentMode } from '#src/chat/AgentMode.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { GlyphAnnotation, GlyphTurnOptions } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { replaceGlyphPromptRange, toGlyphPromptText, type GlyphPromptDocument } from './GlyphPromptDocument.ts';
export interface GlyphAnnotationPosition {
  /** Optional editor-owned mount point that reserves space in the source view. */
  readonly container?: HTMLElement;
  readonly x: number;
  readonly y: number;
  /** Horizontal bounds of the source editor, in viewport coordinates. */
  readonly minX?: number;
  readonly maxX?: number;
}
export interface GlyphQueuedMessage {
  readonly id: string;
  readonly document: GlyphPromptDocument;
  readonly text: string;
}
type SendMessage = (
  text: string,
  attachments: readonly GlyphContextAttachment[],
  options?: GlyphTurnOptions,
) => Promise<void>;

/** Window-owned drafts outlive panes, including sends that settle after unmount. */
export class GlyphComposerState {
  private commandHandler: ((command: GlyphComposerCommand) => void) | undefined;
  private queueSequence = 0;
  private modeTouched = false;
  private annotationSequence = 0;
  private readonly annotationReveals = new Map<
    string,
    (annotation: GlyphAnnotation) => Promise<GlyphAnnotationPosition | undefined>
  >();
  private documents: readonly GlyphPromptDocument[] = [];
  private value: {
    document: GlyphPromptDocument;
    queued: readonly GlyphQueuedMessage[];
    editingQueuedMessage: string | undefined;
    queueSubmitting: string | undefined;
    queuePaused: boolean;
    queueError: string | undefined;
    focus: number;
    editingAnnotation: string | undefined;
    annotationDraft: GlyphAnnotation | undefined;
    draft: string;
    unsent: readonly string[];
    error: string | undefined;
    submitting: boolean;
  } = {
    document: { parts: [], from: 0, to: 0 },
    queued: [],
    editingQueuedMessage: undefined,
    queueSubmitting: undefined,
    queuePaused: false,
    queueError: undefined,
    focus: 0,
    editingAnnotation: undefined,
    annotationDraft: undefined,
    draft: '',
    unsent: [],
    error: undefined,
    submitting: false,
  };
  private readonly listeners = new Set<() => void>();
  registerCommands(handler: (command: GlyphComposerCommand) => void): () => void {
    this.commandHandler = handler;
    return () => {
      if (this.commandHandler === handler) this.commandHandler = undefined;
    };
  }
  executeCommand(command: GlyphComposerCommand): void {
    this.commandHandler?.(command);
  }
  hydrateMode(mode: AgentModeID): void {
    if (!this.modeTouched && this.value.document.options?.mode !== mode)
      this.setDocument({ ...this.value.document, options: { ...this.value.document.options, mode } });
  }
  registerAnnotationSource(
    id: string,
    reveal: (annotation: GlyphAnnotation) => Promise<GlyphAnnotationPosition | undefined>,
  ): void {
    this.annotationReveals.set(id, reveal);
  }
  async revealAnnotation(annotation: GlyphAnnotation): Promise<GlyphAnnotationPosition | undefined> {
    return this.annotationReveals.get(annotation.sourceId)?.(annotation);
  }
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
  restoreDraft(document: GlyphPromptDocument): void {
    if (this.value.document.parts.length > 0) this.documents = [...this.documents, this.value.document];
    this.setDocument(document);
    this.update({ unsent: this.documents.map(value => toGlyphPromptText(value.parts)) });
  }
  setDocument(document: GlyphPromptDocument): void {
    document = { ...document, options: document.options ?? this.value.document.options ?? {} };
    for (const annotation of document.options?.annotations ?? []) {
      this.annotationSequence = Math.max(this.annotationSequence, annotation.order);
    }
    this.update({ document, draft: toGlyphPromptText(document.parts) });
  }
  requestAnnotation(annotation: GlyphAnnotation): void {
    this.update({ annotationDraft: annotation });
  }
  setMode(mode: AgentModeID): void {
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

  /** Revalidate context metadata without changing captured text, selection, or queue order. */
  mapAttachments(map: (attachment: GlyphContextAttachment) => GlyphContextAttachment): void {
    const transform = (document: GlyphPromptDocument): GlyphPromptDocument => ({
      ...document,
      parts: document.parts.map(part =>
        part.type === 'attachment' ? { ...part, attachment: map(part.attachment) } : part,
      ),
    });
    this.documents = this.documents.map(transform);
    const document = transform(this.value.document);
    this.update({
      document,
      draft: toGlyphPromptText(document.parts),
      unsent: this.documents.map(value => toGlyphPromptText(value.parts)),
      queued: this.value.queued.map(message => {
        const transformed = transform(message.document);
        return { ...message, document: transformed, text: toGlyphPromptText(transformed.parts) };
      }),
    });
  }
  editUnsent(index: number): void {
    const document = this.documents[index];
    if (!document) return;
    const previous = this.value.document;
    this.documents = this.documents.flatMap((value, position) =>
      position !== index ? [value] : previous.parts.length > 0 ? [previous] : [],
    );
    this.setDocument(document);
    this.update({ unsent: this.documents.map(value => toGlyphPromptText(value.parts)) });
    this.focus();
  }
  enqueueDraft(): void {
    if (!this.value.draft.trim() || this.value.submitting) return;
    const id = this.value.editingQueuedMessage ?? `queued-${++this.queueSequence}`;
    const message = { id, document: structuredClone(this.value.document), text: this.value.draft };
    const queued = this.value.queued.some(value => value.id === id)
      ? this.value.queued.map(value => (value.id === id ? message : value))
      : [...this.value.queued, message];
    const mode = this.value.document.options?.mode ?? AgentMode.default.id;
    this.update({
      queued,
      editingQueuedMessage: undefined,
      document: { parts: [], from: 0, to: 0, options: { mode } },
      draft: '',
      queueError: undefined,
    });
  }
  editQueued(id: string): void {
    const message = this.value.queued.find(value => value.id === id);
    if (
      !message ||
      (this.value.queueSubmitting !== undefined && this.value.queueSubmitting !== '') ||
      (this.value.editingQueuedMessage !== undefined && this.value.editingQueuedMessage !== '')
    )
      return;
    this.update({ editingQueuedMessage: id });
    this.restoreDraft(structuredClone(message.document));
    this.focus();
  }
  cancelQueueEdit(): void {
    if (this.value.editingQueuedMessage === undefined || this.value.editingQueuedMessage === '') return;
    this.update({
      draft: '',
      document: {
        parts: [],
        from: 0,
        to: 0,
        options: { mode: this.value.document.options?.mode ?? AgentMode.default.id },
      },
      editingQueuedMessage: undefined,
      editingAnnotation: undefined,
      annotationDraft: undefined,
    });
  }
  removeQueued(id: string): void {
    if (this.value.queueSubmitting === id) return;
    this.update({
      queued: this.value.queued.filter(value => value.id !== id),
      editingQueuedMessage: this.value.editingQueuedMessage === id ? undefined : this.value.editingQueuedMessage,
      ...(this.value.editingQueuedMessage === id && {
        draft: '',
        document: {
          parts: [],
          from: 0,
          to: 0,
          options: { mode: this.value.document.options?.mode ?? AgentMode.default.id },
        },
      }),
    });
  }
  moveQueued(id: string, target: number): void {
    if (this.value.queueSubmitting !== undefined && this.value.queueSubmitting !== '') return;
    const queued = [...this.value.queued];
    const from = queued.findIndex(value => value.id === id);
    if (from < 0) return;
    const [message] = queued.splice(from, 1);
    queued.splice(Math.max(0, Math.min(target, queued.length)), 0, message!);
    this.update({ queued });
  }
  pauseQueue(): void {
    if (this.value.queued.length > 0) this.update({ queuePaused: true });
  }
  resumeQueue(): void {
    this.update({ queuePaused: false, queueError: undefined });
  }
  async sendQueued(id: string, send: SendMessage): Promise<void> {
    const message = this.value.queued.find(value => value.id === id);
    if (
      !message ||
      (this.value.queueSubmitting !== undefined && this.value.queueSubmitting !== '') ||
      (this.value.editingQueuedMessage !== undefined && this.value.editingQueuedMessage !== '')
    )
      return;
    this.update({ queueSubmitting: id, queueError: undefined });
    try {
      await sendDocument(message.document, send);
      this.update({ queued: this.value.queued.filter(value => value.id !== id) });
    } catch (error) {
      this.update({ queuePaused: true, queueError: error instanceof Error ? error.message : String(error) });
    } finally {
      this.update({ queueSubmitting: undefined });
    }
  }
  async submit(send: SendMessage): Promise<void> {
    if (this.value.submitting || !this.value.draft.trim()) return;
    const { document } = this.value;
    this.update({
      draft: '',
      document: { parts: [], from: 0, to: 0, options: { mode: document.options?.mode ?? AgentMode.default.id } },
      editingAnnotation: undefined,
      annotationDraft: undefined,
      error: undefined,
      submitting: true,
    });
    try {
      await sendDocument(document, send);
    } catch (error) {
      if (this.value.document.parts.length > 0) this.documents = [...this.documents, document];
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

/** Both queued and direct sends preserve the same exact captures and UTF-16 spans. */
async function sendDocument(document: GlyphPromptDocument, send: SendMessage): Promise<void> {
  const draft = toGlyphPromptText(document.parts);
  const attachments = document.parts.flatMap(part => (part.type === 'attachment' ? [part.attachment] : []));
  let offset = -(draft.length - draft.trimStart().length);
  const attachmentSpans = document.parts.flatMap(part => {
    const from = offset;
    offset += toGlyphPromptText([part]).length;
    return part.type === 'attachment' ? [{ from, to: offset }] : [];
  });
  await send(draft, attachments, { ...document.options, ...(attachmentSpans.length > 0 ? { attachmentSpans } : {}) });
}
