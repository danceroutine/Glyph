import { AgentModeID } from '#src/chat/AgentMode.js';
import type { GlyphPlanRecord } from './GlyphPlanRecord.ts';
import type { GlyphTodoItem } from './GlyphTodoItem.ts';
import type { GlyphGoal } from './GlyphGoal.ts';

export interface GlyphChatSummary {
  readonly id: string;
  readonly title: string;
  readonly accountProvider: string;
  readonly accountId: string;
  readonly modelSlug: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly plans?: readonly GlyphPlanRecord[];
  readonly mode?: AgentModeID;
  readonly todos?: readonly GlyphTodoItem[];
  readonly goal?: GlyphGoal;
}
