/** Window-owned drafts outlive panes, including sends that settle after unmount. */
export class GlyphComposerState {
  private value: { draft: string; unsent: readonly string[]; error: string | undefined; submitting: boolean } = {
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
    this.update({ draft });
  }
  editUnsent(index: number): void {
    const draft = this.value.unsent[index];
    if (draft === undefined) return;
    const previous = this.value.draft;
    this.update({
      draft,
      unsent: this.value.unsent.flatMap((text, position) => {
        if (position !== index) return [text];
        return previous ? [previous] : [];
      }),
    });
  }
  async submit(send: (text: string) => Promise<void>): Promise<void> {
    if (this.value.submitting || !this.value.draft.trim()) return;
    const text = this.value.draft;
    this.update({ draft: '', error: undefined, submitting: true });
    try {
      await send(text);
    } catch (error) {
      // Read current state: a remounted pane may already contain another draft.
      const recovered = this.value.draft ? { unsent: [...this.value.unsent, text] } : { draft: text };
      this.update({ ...recovered, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.update({ submitting: false });
    }
  }
  private update(change: Partial<typeof this.value>): void {
    this.value = { ...this.value, ...change };
    for (const listener of this.listeners) listener();
  }
}
