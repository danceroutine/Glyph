import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphPlanBuildOrder } from '#src/desktop/protocol/events/GlyphPlanBuildOrder.js';

export enum GlyphPlanPromptIntent {
  BUILD = 'Build this approved plan',
  REVIEW = 'Review this plan',
}

export function toGlyphPlanPromptHeading(
  intent: GlyphPlanPromptIntent,
  plan: Pick<GlyphPlan, 'id' | 'revision' | 'title'>,
): string {
  return `${intent}: ${plan.title} (plan ${plan.id}, revision ${plan.revision}).`;
}

export function toGlyphPlanBuildLead(text: string, build: GlyphPlanBuildOrder): string {
  const heading = toGlyphPlanPromptHeading(GlyphPlanPromptIntent.BUILD, {
    id: build.planId,
    revision: build.revision,
    title: build.title,
  });
  const index = text.indexOf(heading);
  return index < 0 ? '' : text.slice(0, index).trimEnd();
}

export function toGlyphPlanPrompt(intent: GlyphPlanPromptIntent, plan: GlyphPlan): string {
  const building = intent === GlyphPlanPromptIntent.BUILD;
  const todos = plan.todos.map(
    todo => `- [${todo.completed ? 'x' : ' '}] ${todo.text}${building ? ` (todo id: ${todo.id})` : ''}`,
  );
  return [
    toGlyphPlanPromptHeading(intent, plan),
    plan.markdown,
    `Todos:\n${todos.join('\n')}`,
    ...(building && plan.todos.length
      ? ['These todos are already on your todo list. Update them by ID with update_todos as you work.']
      : []),
  ].join('\n\n');
}
