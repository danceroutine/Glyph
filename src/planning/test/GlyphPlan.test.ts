import { describe, expect, it } from 'vitest';
import { GlyphPlan } from '#src/planning/GlyphPlan.js';
import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';

const record = (overrides: Partial<GlyphPlanRecord> = {}): GlyphPlanRecord => ({
  id: 'plan',
  revision: 1,
  title: 'Ship it',
  summary: 'Summary',
  markdown: '# Ship it',
  todos: [
    { id: 'first', text: 'First', completed: false },
    { id: 'second', text: 'Second', completed: true },
  ],
  agents: [{ chatId: 'author', role: 'Author' }],
  ...overrides,
});

const update = {
  id: null,
  expectedRevision: null,
  title: 'Revised',
  summary: 'New summary',
  markdown: '# Revised',
  todos: [{ id: 'next', text: 'Next', completed: false }],
};

describe(GlyphPlan, () => {
  it('creates, reads and revises persisted records without leaking a class across the boundary', () => {
    const created = GlyphPlan.create('created', 'author', update);

    expect(created.id).toBe('created');
    expect(created.revision).toBe(1);
    expect(created.title).toBe('Revised');
    expect(created.todos).toEqual(update.todos);
    expect(created.build).toBeUndefined();
    expect(created.toRecord()).toEqual({
      id: 'created',
      revision: 1,
      title: 'Revised',
      summary: 'New summary',
      markdown: '# Revised',
      todos: update.todos,
      agents: [{ chatId: 'author', role: 'Author' }],
    });

    const building = GlyphPlan.from(
      record({ build: { chatId: 'builder', runId: 'run', startedAt: '2026-10-23T10:00:00.000Z' } }),
    );
    expect(building.revise(update).toRecord()).toMatchObject({
      revision: 2,
      title: 'Revised',
      build: building.build,
    });
    expect(created.revise(update).toRecord()).not.toHaveProperty('build');
  });

  it('links builders and reviewers without changing the author role', () => {
    const plan = GlyphPlan.from(record());
    const linked = plan.link('builder', 'Builder');
    const reviewed = linked.link('builder', 'Reviewer');
    const author = reviewed.link('author', 'Builder');

    expect(linked.toRecord().agents).toContainEqual({ chatId: 'builder', role: 'Builder' });
    expect(reviewed.toRecord().agents).toContainEqual({ chatId: 'builder', role: 'Reviewer' });
    expect(author.toRecord().agents).toContainEqual({ chatId: 'author', role: 'Author' });
  });

  it('owns build lifecycle and pauses only the matching completed run', () => {
    const started = GlyphPlan.from(record()).startBuild('builder', 'run', new Date('2026-10-23T10:00:00.000Z'));

    expect(started.build).toEqual({
      chatId: 'builder',
      runId: 'run',
      startedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(started.finishBuildRun('other', 'run')).toBe(started);
    expect(started.finishBuildRun('builder', 'other')).toBe(started);
    expect(started.finishBuildRun('builder', 'run')).toBe(started);
    expect(started.pauseBuild().build).toBeUndefined();
    const idleRecord = record();
    expect(GlyphPlan.from(idleRecord).pauseBuild().toRecord()).toBe(idleRecord);

    const completed = GlyphPlan.from(record({ todos: [{ id: 'done', text: 'Done', completed: true }] })).startBuild(
      'builder',
      'run',
      new Date('2026-10-23T10:00:00.000Z'),
    );
    expect(completed.finishBuildRun('builder', 'run').build).toBeUndefined();
  });

  it('namespaces builder todos and synchronizes progress without cross-plan IDs', () => {
    const started = GlyphPlan.from(record()).startBuild('builder', 'run', new Date('2026-10-23T10:00:00.000Z'));

    expect(started.builderTodos()).toEqual([
      { id: 'plan:plan:first', text: 'First', status: TodoStatus.PENDING },
      { id: 'plan:plan:second', text: 'Second', status: TodoStatus.COMPLETED },
    ]);
    expect(started.builderTodoIdForLocal('first')).toBe('plan:plan:first');
    expect(started.builderTodoIdForLocal('missing')).toBeUndefined();
    expect(started.syncBuilderTodos(new Map())).toBe(started);
    expect(started.syncBuilderTodos(new Map([['plan:plan:first', TodoStatus.PENDING]]))).toBe(started);

    const synced = started.syncBuilderTodos(
      new Map([
        ['plan:plan:first', TodoStatus.COMPLETED],
        ['plan:plan:second', TodoStatus.PENDING],
      ]),
    );
    expect(synced.todos.map(todo => todo.completed)).toEqual([true, false]);
    expect(synced.build).toEqual(started.build);
  });

  it('updates a plan todo, settles the final item and rejects an unknown ID', () => {
    const started = GlyphPlan.from(record({ todos: [{ id: 'only', text: 'Only', completed: false }] })).startBuild(
      'builder',
      'run',
      new Date('2026-10-23T10:00:00.000Z'),
    );

    expect(started.setTodo('only', true).toRecord()).toMatchObject({
      todos: [{ id: 'only', completed: true }],
    });
    expect(started.setTodo('only', true).build).toBeUndefined();
    expect(() => started.setTodo('missing', true)).toThrow('The plan todo is unavailable.');
  });
});
