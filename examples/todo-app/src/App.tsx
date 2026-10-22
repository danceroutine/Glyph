import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';

type Filter = 'all' | 'active' | 'completed';

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
}

const STORAGE_KEY = 'glyph.todo-app.todos';
const filters: Filter[] = ['all', 'active', 'completed'];

function isTodo(value: unknown): value is Todo {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'completed' in value &&
    typeof value.completed === 'boolean' &&
    'createdAt' in value &&
    typeof value.createdAt === 'number'
  );
}

function loadTodos(): Todo[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];

    const value: unknown = JSON.parse(saved);
    if (!Array.isArray(value)) return [];

    return value.filter(item => isTodo(item));
  } catch {
    return [];
  }
}

export function App() {
  const [todos, setTodos] = useState<Todo[]>(loadTodos);
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [todos]);

  const visibleTodos = useMemo(
    () =>
      todos.filter(todo => {
        if (filter === 'active') return !todo.completed;
        if (filter === 'completed') return todo.completed;
        return true;
      }),
    [filter, todos],
  );

  const activeCount = todos.filter(todo => !todo.completed).length;
  const completedCount = todos.length - activeCount;

  function addTodo(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;

    setTodos(current => [...current, { id: crypto.randomUUID(), title, completed: false, createdAt: Date.now() }]);
    setDraft('');
  }

  function toggleTodo(id: string) {
    setTodos(current => current.map(todo => (todo.id === id ? { ...todo, completed: !todo.completed } : todo)));
  }

  function removeTodo(id: string) {
    setTodos(current => current.filter(todo => todo.id !== id));
  }

  function clearCompleted() {
    setTodos(current => current.filter(todo => !todo.completed));
  }

  return (
    <main className="page-shell">
      <section className="todo-card" aria-labelledby="page-title">
        <header className="card-header">
          <p className="eyebrow">Today, gently</p>
          <h1 id="page-title">Little List</h1>
          <p className="intro">Keep the next few things somewhere quieter than your head.</p>
        </header>

        <form className="add-form" onSubmit={addTodo}>
          <label className="sr-only" htmlFor="new-todo">
            Add a task
          </label>
          <input
            id="new-todo"
            value={draft}
            onChange={event => {
              setDraft(event.target.value);
            }}
            placeholder="What needs doing?"
            autoComplete="off"
          />
          <button className="add-button" type="submit" disabled={!draft.trim()}>
            Add task
          </button>
        </form>

        <div className="list-controls">
          <div className="filters" aria-label="Filter tasks">
            {filters.map(name => (
              <button
                className={filter === name ? 'filter active' : 'filter'}
                key={name}
                type="button"
                aria-pressed={filter === name}
                onClick={() => {
                  setFilter(name);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <span className="task-count">
            {activeCount} {activeCount === 1 ? 'task' : 'tasks'} left
          </span>
        </div>

        {visibleTodos.length > 0 ? (
          <ul className="todo-list">
            {visibleTodos.map(todo => (
              <li className={todo.completed ? 'todo-item completed' : 'todo-item'} key={todo.id}>
                <label className="todo-label">
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => {
                      toggleTodo(todo.id);
                    }}
                  />
                  <span className="checkmark" aria-hidden="true" />
                  <span className="todo-title">{todo.title}</span>
                </label>
                <button
                  className="delete-button"
                  type="button"
                  onClick={() => {
                    removeTodo(todo.id);
                  }}
                  aria-label={`Delete ${todo.title}`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-state">
            <span aria-hidden="true">✓</span>
            <p>
              {todos.length === 0
                ? 'Your list is clear. Add something when you’re ready.'
                : `No ${filter} tasks right now.`}
            </p>
          </div>
        )}

        <footer className="card-footer">
          <span>{todos.length === 0 ? 'Nothing on your plate' : `${todos.length} total`}</span>
          {completedCount > 0 && (
            <button type="button" onClick={clearCompleted}>
              Clear completed
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}
