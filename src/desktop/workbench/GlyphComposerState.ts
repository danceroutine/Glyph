import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { replaceGlyphPromptRange, toGlyphPromptText, type GlyphPromptDocument } from './GlyphPromptDocument.ts';
/** Window-owned drafts outlive panes, including sends that settle after unmount. */
export class GlyphComposerState {
  private documents: readonly GlyphPromptDocument[] = [];
  private value: {
    document: GlyphPromptDocument;
    focus: number;
    draft: string;
    unsent: readonly string[];
    error: string | undefined;
    submitting: boolean;
  } = {
    document: { parts: [], from: 0, to: 0 },
    focus: 0,
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
    this.update({ document, draft: toGlyphPromptText(document.parts) });
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
    this.setDocument({ parts, from, to });
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
  async submit(send: (text: string, attachments: readonly GlyphContextAttachment[]) => Promise<void>): Promise<void> {
    if (this.value.submitting || !this.value.draft.trim()) return;
    const { document, draft } = this.value;
    const attachments = document.parts.flatMap(part => (part.type === 'attachment' ? [part.attachment] : []));
    this.update({ draft: '', document: { parts: [], from: 0, to: 0 }, error: undefined, submitting: true });
    try {
      await send(draft, attachments);
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
