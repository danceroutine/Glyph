/** Serializable plan state carried by persistence and desktop protocol boundaries. */
export interface GlyphPlanRecord {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
  readonly todos: readonly { readonly id: string; readonly text: string; readonly completed: boolean }[];
  readonly agents: readonly { readonly chatId: string; readonly role: 'Author' | 'Builder' | 'Reviewer' }[];
  readonly build?: GlyphPlanBuildRecord;
}

export interface GlyphPlanBuildRecord {
  readonly chatId: string;
  readonly runId: string;
  readonly startedAt: string;
}
