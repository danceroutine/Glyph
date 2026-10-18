/** Saved plan revisions are immutable; edits create a new revision. */
export interface GlyphPlan {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
  readonly todos: readonly { readonly id: string; readonly text: string; readonly completed: boolean }[];
  readonly agents: readonly { readonly chatId: string; readonly role: 'Author' | 'Builder' | 'Reviewer' }[];
}
