import type { ComponentChildren } from 'preact';
import { Circle, CircleCheck, MessageSquare, Plus, ChevronRight, LibraryBig } from 'lucide-preact';
import { planStyles } from './GlyphPlan.styles.ts';
import { GlyphPlanBuild } from './GlyphPlanBuild.presentational.tsx';
import type { GlyphPlanState } from './useGlyphPlanState.ts';
export function GlyphPlan(state: GlyphPlanState & { readonly markdown: ComponentChildren }) {
  return (
    <div
      class={`glyph-plan-document ${planStyles.root}`}
      onKeyDown={event => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          void state.build();
        }
      }}
    >
      <header class={planStyles.toolbar}>
        <div class={planStyles.breadcrumb} title={`${state.plan.title} · Revision ${state.plan.revision}`}>
          <span>Plans</span>
          <ChevronRight size={14} aria-hidden="true" />
          <LibraryBig size={15} aria-hidden="true" />
          <span>{state.plan.title}</span>
        </div>
        <div class={planStyles.toolbarActions}>
          {state.modelLabel && (
            <span class={planStyles.model} title="Model for this plan's chat">
              {state.modelLabel}
            </span>
          )}
          <GlyphPlanBuild disabled={state.disabled} build={state.build} buildNew={state.buildNew} />
        </div>
      </header>
      <main class={planStyles.main}>
        <div
          class={planStyles.markdown}
          data-glyph-source={state.plan.id}
          data-kind="plan"
          data-label={state.plan.title}
          data-revision={state.plan.revision}
        >
          {state.markdown}
        </div>
        <section class={planStyles.section} aria-label="Plan todos">
          <header>
            <h3>{state.plan.todos.length} To-dos</h3>
            <button class={planStyles.button} aria-label="New todo" disabled={state.disabled} onClick={state.add}>
              <Plus size={16} />
              New
            </button>
          </header>
          <ul>
            {state.plan.todos.map(todo => (
              <li key={todo.id}>
                <button
                  class={planStyles.row}
                  aria-label={`Mark ${todo.text} ${todo.completed ? 'pending' : 'completed'}`}
                  disabled={state.disabled}
                  onClick={() => state.toggleTodo(todo.id)}
                >
                  {todo.completed ? <CircleCheck size={16} /> : <Circle size={16} />}
                  <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>{todo.text}</span>
                </button>
              </li>
            ))}
          </ul>
          {state.adding && (
            <form
              class={planStyles.todoForm}
              onSubmit={event => {
                event.preventDefault();
                void state.saveTodo();
              }}
            >
              <Circle size={16} aria-hidden="true" />
              <input
                aria-label="Todo description"
                placeholder="Todo description…"
                ref={state.input}
                value={state.todo}
                maxLength={1000}
                disabled={state.disabled}
                onInput={event => state.setTodo(event.currentTarget.value)}
              />
              <button class={planStyles.button} disabled={state.disabled || !state.todo.trim()}>
                Add
              </button>
            </form>
          )}
        </section>
        <section class={planStyles.section} aria-label="Referenced agents">
          <header>
            <h3>
              Referenced by {state.agents.length} {state.agents.length === 1 ? 'Agent' : 'Agents'}
            </h3>
            <button class={planStyles.button} aria-label="New agent" disabled={state.disabled} onClick={state.newAgent}>
              <Plus size={16} />
              New
            </button>
          </header>
          <ul>
            {state.agents.map(agent => (
              <li key={agent.chatId}>
                <button class={`${planStyles.row} ${planStyles.agentRow}`} onClick={() => state.openChat(agent.chatId)}>
                  <MessageSquare size={16} />
                  <span>
                    {agent.title} · {agent.role}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        {state.error && <p role="alert">{state.error}</p>}
      </main>
    </div>
  );
}
