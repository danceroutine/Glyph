import { useEffect, useRef, useState } from 'preact/hooks';
import type { GlyphPlanViewActions, GlyphPlanViewState } from '#src/desktop/workbench/GlyphPlanView.js';
export function useGlyphPlanState({
  state,
  actions,
}: {
  readonly state: GlyphPlanViewState;
  readonly actions: GlyphPlanViewActions;
}) {
  const [todo, setTodo] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);
  const perform = async (operation: () => Promise<void>, gated = true) => {
    if (busy.current || (gated && state.disabled)) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const build = (newChat?: boolean) => {
    if (state.building) return Promise.resolve();
    return perform(async () => {
      setRequested(true);
      try {
        await (newChat ? actions.build(true) : actions.build());
      } finally {
        setRequested(false);
      }
    });
  };
  return {
    ...state,
    disabled: state.disabled || pending,
    building: !!state.building || requested,
    error,
    todo,
    adding,
    input,
    setTodo,
    add: () => {
      setAdding(true);
    },
    saveTodo: () =>
      perform(async () => {
        if (!todo.trim()) return;
        await actions.update({
          ...state.plan,
          todos: [...state.plan.todos, { id: crypto.randomUUID(), text: todo.trim(), completed: false }],
        });
        setTodo('');
        setAdding(false);
      }),
    toggleTodo: (id: string) =>
      perform(() => actions.setTodo(id, !state.plan.todos.find(item => item.id === id)?.completed)),
    build: () => build(),
    buildNew: () => build(true),
    stop: () => perform(() => actions.stopBuild(), false),
    newAgent: () => perform(() => actions.newAgent()),
    openChat: (id: string) => perform(() => actions.openChat(id)),
    openLink: (href: string) => {
      void perform(() => actions.openLink(href));
    },
  };
}
export type GlyphPlanState = ReturnType<typeof useGlyphPlanState>;
