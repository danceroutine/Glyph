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
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current || state.disabled) return;
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
  return {
    ...state,
    disabled: state.disabled || pending,
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
      perform(() =>
        actions.update({
          ...state.plan,
          todos: state.plan.todos.map(item => (item.id === id ? { ...item, completed: !item.completed } : item)),
        }),
      ),
    build: () => perform(() => actions.build()),
    buildNew: () => perform(() => actions.build(true)),
    newAgent: () => perform(() => actions.newAgent()),
    openChat: (id: string) => perform(() => actions.openChat(id)),
    openLink: (href: string) => {
      void perform(() => actions.openLink(href));
    },
  };
}
export type GlyphPlanState = ReturnType<typeof useGlyphPlanState>;
