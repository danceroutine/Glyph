import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
import { PlanError } from './PlanError.ts';
import type { PlanUpdate } from './PlanSchema.ts';
import type { TodoItem } from '#src/todos/TodoItem.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';

/**
 * Live domain model for a persisted plan revision.
 *
 * The record remains the JSON and desktop-protocol contract. This class owns
 * the transitions that must stay coherent across that boundary: revision,
 * build ownership, namespaced builder todos, progress synchronization, and
 * pause/resume behavior.
 */
export class GlyphPlan {
  private constructor(private readonly record: GlyphPlanRecord) {}

  static create(id: string, authorChatId: string, update: PlanUpdate): GlyphPlan {
    return new GlyphPlan({
      id,
      revision: 1,
      title: update.title,
      summary: update.summary,
      markdown: update.markdown,
      todos: update.todos,
      agents: [{ chatId: authorChatId, role: 'Author' }],
    });
  }

  static from(record: GlyphPlanRecord): GlyphPlan {
    return new GlyphPlan(record);
  }

  get id(): string {
    return this.record.id;
  }

  get revision(): number {
    return this.record.revision;
  }

  get title(): string {
    return this.record.title;
  }

  get todos(): GlyphPlanRecord['todos'] {
    return this.record.todos;
  }

  get build(): GlyphPlanRecord['build'] {
    return this.record.build;
  }

  toRecord(): GlyphPlanRecord {
    return this.record;
  }

  revise(update: PlanUpdate): GlyphPlan {
    return new GlyphPlan({
      id: this.record.id,
      revision: this.record.revision + 1,
      title: update.title,
      summary: update.summary,
      markdown: update.markdown,
      todos: update.todos,
      agents: this.record.agents,
      ...(this.record.build ? { build: this.record.build } : {}),
    });
  }

  link(chatId: string, role: 'Builder' | 'Reviewer'): GlyphPlan {
    const agents = this.record.agents.some(agent => agent.chatId === chatId)
      ? this.record.agents.map(agent =>
          agent.chatId === chatId && agent.role !== 'Author' ? { ...agent, role } : agent,
        )
      : [...this.record.agents, { chatId, role }];
    return new GlyphPlan({ ...this.record, agents });
  }

  startBuild(chatId: string, runId: string, now: Date): GlyphPlan {
    return new GlyphPlan({ ...this.record, build: { chatId, runId, startedAt: now.toISOString() } });
  }

  pauseBuild(): GlyphPlan {
    if (!this.record.build) return this;
    const { build: _, ...paused } = this.record;
    return new GlyphPlan(paused);
  }

  finishBuildRun(chatId: string, runId: string): GlyphPlan {
    if (this.record.build?.chatId !== chatId || this.record.build.runId !== runId) return this;
    return this.record.todos.some(todo => !todo.completed) ? this : this.pauseBuild();
  }

  setTodo(todoId: string, completed: boolean): GlyphPlan {
    if (!this.record.todos.some(todo => todo.id === todoId)) throw new PlanError('The plan todo is unavailable.');
    return this.settle(
      new GlyphPlan({
        ...this.record,
        todos: this.record.todos.map(todo => (todo.id === todoId ? { ...todo, completed } : todo)),
      }),
    );
  }

  syncBuilderTodos(status: ReadonlyMap<string, TodoStatus>): GlyphPlan {
    let changed = false;
    const todos = this.record.todos.map(todo => {
      const value = status.get(this.builderTodoId(todo.id));
      const completed = value === TodoStatus.COMPLETED;
      if (value === undefined || completed === todo.completed) return todo;
      changed = true;
      return { ...todo, completed };
    });
    if (!changed) return this;
    return this.settle(new GlyphPlan({ ...this.record, todos }));
  }

  builderTodos(): readonly TodoItem[] {
    return this.record.todos.map(todo => ({
      id: this.builderTodoId(todo.id),
      text: todo.text,
      status: todo.completed ? TodoStatus.COMPLETED : TodoStatus.PENDING,
    }));
  }

  builderTodoIdForLocal(todoId: string): string | undefined {
    return this.record.todos.some(todo => todo.id === todoId) ? this.builderTodoId(todoId) : undefined;
  }

  private builderTodoId(todoId: string): string {
    return `plan:${this.record.id}:${todoId}`;
  }

  private settle(plan: GlyphPlan): GlyphPlan {
    return plan.record.build && plan.record.todos.length > 0 && plan.record.todos.every(todo => todo.completed)
      ? plan.pauseBuild()
      : plan;
  }
}
