/** Read-only display state; stable IDs are scoped to the enclosing chat. */
export interface GlyphTodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}
