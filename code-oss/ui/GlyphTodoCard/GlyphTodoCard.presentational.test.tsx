import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphTodoCard } from '#code-oss/ui/GlyphTodoCard/GlyphTodoCard.presentational.tsx';

afterEach(cleanup);

describe(GlyphTodoCard, () => {
  it('shows each todo with an icon describing its status', () => {
    render(
      <GlyphTodoCard
        expanded
        listId="todos"
        summary="1 of 3 To-dos completed"
        toggle={vi.fn()}
        items={[
          { id: 'a', text: 'Plan', status: 'completed', label: 'Completed', path: 'm5 8 2 2 4-4', filled: false },
          {
            id: 'b',
            text: 'Build',
            status: 'in_progress',
            label: 'In progress',
            path: 'M8 3a5 5 0 0 1 0 10Z',
            filled: true,
          },
          { id: 'c', text: 'Ship', status: 'pending', label: 'Pending', path: null, filled: false },
        ]}
      />,
    );

    const toggle = screen.getByRole('button', { name: '1 of 3 To-dos completed' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('todos');
    expect(screen.getByRole('list', { name: 'Todo items' }).id).toBe('todos');
    const completed = screen.getByRole('img', { name: 'Completed' }).querySelector('path')!;
    expect([completed.getAttribute('fill'), completed.getAttribute('stroke')]).toEqual(['none', 'currentColor']);
    const progress = screen.getByRole('img', { name: 'In progress' }).querySelector('path')!;
    expect([progress.getAttribute('fill'), progress.getAttribute('stroke')]).toEqual(['currentColor', 'none']);
    expect(screen.getByRole('img', { name: 'Pending' }).querySelector('path')).toBeNull();
    expect(screen.getByText('Plan').className).not.toBe(screen.getByText('Ship').className);
    expect(screen.getByText('Build').className).toBe(screen.getByText('Ship').className);
  });

  it('hides the list while collapsed and toggles it', () => {
    const toggle = vi.fn();
    const { container } = render(
      <GlyphTodoCard expanded={false} listId="todos" summary="0 of 0 To-dos completed" toggle={toggle} items={[]} />,
    );

    const button = screen.getByRole('button', { name: '0 of 0 To-dos completed' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[aria-hidden="true"][inert]')?.contains(container.querySelector('ul'))).toBe(true);

    fireEvent.click(button);

    expect(toggle).toHaveBeenCalledOnce();
  });
});
