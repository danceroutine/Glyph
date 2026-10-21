import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { WiredGlyphTodoCard } from '#code-oss/ui/GlyphTodoCard/GlyphTodoCard.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphTodoCard, () => {
  it('expands to reveal the todos', () => {
    render(<WiredGlyphTodoCard items={[{ id: 'a', text: 'Plan', status: 'completed' }]} />);
    const toggle = screen.getByRole('button', { name: '1 of 1 To-dos completed' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('img', { name: 'Completed' })).toBeTruthy();
  });
});
