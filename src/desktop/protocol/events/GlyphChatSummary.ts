import type { GlyphPlan } from './GlyphPlan.ts';
import type { GlyphTodoItem } from './GlyphTodoItem.ts';

export interface GlyphChatSummary {
  readonly id: string;
  readonly title: string;
  readonly accountProvider: string;
  readonly accountId: string;
  readonly modelSlug: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly plans?: readonly GlyphPlan[];
  readonly mode?: 'agent' | 'plan';
  readonly todos?: readonly GlyphTodoItem[];
}
