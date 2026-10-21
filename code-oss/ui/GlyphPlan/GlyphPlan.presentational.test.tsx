import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphPlan } from '#code-oss/ui/GlyphPlan/GlyphPlan.presentational.tsx';
import type { GlyphPlanState } from '#code-oss/ui/GlyphPlan/useGlyphPlanState.ts';

afterEach(cleanup);

const planState = (overrides: Partial<GlyphPlanState> = {}): GlyphPlanState => ({
  plan: {
    id: 'plan',
    revision: 2,
    title: 'Ship it',
    summary: 'Summary',
    markdown: '# Ship it',
    todos: [
      { id: 'a', text: 'First', completed: false },
      { id: 'b', text: 'Second', completed: true },
    ],
    agents: [],
  },
  agents: [],
  disabled: false,
  error: undefined,
  todo: '',
  adding: false,
  input: createRef<HTMLInputElement>(),
  setTodo: vi.fn(),
  add: vi.fn(),
  saveTodo: vi.fn(async () => {}),
  toggleTodo: vi.fn(async (_id: string) => {}),
  build: vi.fn(async () => {}),
  buildNew: vi.fn(async () => {}),
  newAgent: vi.fn(async () => {}),
  openChat: vi.fn(async (_id: string) => {}),
  openLink: vi.fn(),
  ...overrides,
});

describe(GlyphPlan, () => {
  it('shows the plan document with its title and revision', () => {
    const { container } = render(<GlyphPlan {...planState()} markdown={<p>Plan body</p>} />);

    expect(container.querySelector('[title="Ship it · Revision 2"]')?.textContent).toBe('PlansShip it');
    const document = container.querySelector('[data-kind="plan"]') as HTMLElement;
    expect(document.dataset.glyphSource).toBe('plan');
    expect(document.dataset.label).toBe('Ship it');
    expect(document.dataset.revision).toBe('2');
    expect(document.textContent).toBe('Plan body');
    expect(screen.queryByTitle("Model for this plan's chat")).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the model used by the plan chat', () => {
    render(<GlyphPlan {...planState({ modelLabel: 'GPT-5' })} markdown={null} />);

    expect(screen.getByTitle("Model for this plan's chat").textContent).toBe('GPT-5');
  });

  it('builds the plan here or in a new chat', () => {
    const state = planState();
    render(<GlyphPlan {...state} markdown={null} />);

    fireEvent.click(screen.getByRole('button', { name: /^Build\s*⌘↵$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Build options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build in new chat' }));

    expect(state.build).toHaveBeenCalledOnce();
    expect(state.buildNew).toHaveBeenCalledOnce();
  });

  it('builds the plan with the command or control enter shortcut', () => {
    const state = planState();
    const { container } = render(<GlyphPlan {...state} markdown={null} />);
    const root = container.firstElementChild!;

    const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    root.dispatchEvent(plain);
    fireEvent.keyDown(root, { key: 'b', metaKey: true });
    expect(state.build).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);

    const command = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true });
    root.dispatchEvent(command);
    fireEvent.keyDown(root, { key: 'Enter', ctrlKey: true });

    expect(command.defaultPrevented).toBe(true);
    expect(state.build).toHaveBeenCalledTimes(2);
  });

  it('lists todos and toggles their completion', () => {
    const state = planState();
    render(<GlyphPlan {...state} markdown={null} />);

    expect(screen.getByRole('heading', { name: '2 To-dos' })).toBeTruthy();
    expect(screen.getByText('First').style.textDecoration).toBe('none');
    expect(screen.getByText('Second').style.textDecoration).toBe('line-through');

    fireEvent.click(screen.getByRole('button', { name: 'Mark First completed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Second pending' }));

    expect(vi.mocked(state.toggleTodo).mock.calls).toEqual([['a'], ['b']]);
  });

  it('starts adding a todo', () => {
    const state = planState();
    render(<GlyphPlan {...state} markdown={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'New todo' }));

    expect(state.add).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Todo description' })).toBeNull();
  });

  it('edits and submits a new todo', () => {
    const state = planState({ adding: true, todo: 'Third' });
    render(<GlyphPlan {...state} markdown={null} />);
    const input = screen.getByRole('textbox', { name: 'Todo description' }) as HTMLInputElement;
    expect(input.value).toBe('Third');
    expect(state.input.current).toBe(input);

    fireEvent.input(input, { target: { value: 'Third todo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(state.setTodo).toHaveBeenCalledWith('Third todo');
    expect(state.saveTodo).toHaveBeenCalledOnce();
  });

  it('cannot submit a blank todo', () => {
    render(<GlyphPlan {...planState({ adding: true, todo: '  ' })} markdown={null} />);

    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables editing while unavailable', () => {
    render(<GlyphPlan {...planState({ adding: true, todo: 'Third', disabled: true })} markdown={null} />);

    for (const name of ['New todo', 'Mark First completed', 'Add', 'New agent'])
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', { name: 'Todo description' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('lists the agents referencing the plan and opens their chats', () => {
    const state = planState({
      agents: [
        { chatId: 'one', title: 'Author chat', role: 'Author' },
        { chatId: 'two', title: 'Builder chat', role: 'Builder' },
      ],
    });
    render(<GlyphPlan {...state} markdown={null} />);

    expect(screen.getByRole('heading', { name: 'Referenced by 2 Agents' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Builder chat · Builder' }));
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));

    expect(state.openChat).toHaveBeenCalledWith('two');
    expect(state.newAgent).toHaveBeenCalledOnce();
  });

  it('counts a single referencing agent in the singular', () => {
    render(
      <GlyphPlan {...planState({ agents: [{ chatId: 'one', title: 'Chat', role: 'Author' }] })} markdown={null} />,
    );

    expect(screen.getByRole('heading', { name: 'Referenced by 1 Agent' })).toBeTruthy();
  });

  it('shows why the last action failed', () => {
    render(<GlyphPlan {...planState({ error: 'Offline' })} markdown={null} />);

    expect(screen.getByRole('alert').textContent).toBe('Offline');
  });
});
