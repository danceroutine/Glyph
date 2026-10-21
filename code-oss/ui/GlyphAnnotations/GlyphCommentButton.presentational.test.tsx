import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphCommentButton } from '#code-oss/ui/GlyphAnnotations/GlyphCommentButton.presentational.tsx';

afterEach(cleanup);

describe(GlyphCommentButton, () => {
  it('offers to add a selection to the chat, centered over it', () => {
    const open = vi.fn();
    render(<GlyphCommentButton open={open} position={{ x: 200, y: 50 }} shortcut="⌘L" />);

    const button = screen.getByRole('button', { name: 'Comment on selection' });
    const width = button.getBoundingClientRect().width;
    expect(button.textContent).toBe('Add to Chat⌘L');
    expect(button.style.left).toBe(`${Math.max(8, Math.min(innerWidth - width - 8, 200 - width / 2))}px`);
    expect(button.style.top).toBe('50px');
    expect(getComputedStyle(button).position).toBe('fixed');
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);

    expect(open).toHaveBeenCalledOnce();
  });

  it('keeps the selection button inside the viewport', () => {
    render(<GlyphCommentButton open={vi.fn()} position={{ x: -500, y: 10 }} />);

    expect(screen.getByRole('button', { name: 'Comment on selection' }).style.left).toBe('8px');
  });

  it('flows inline when it has no position', () => {
    render(<GlyphCommentButton open={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Comment on selection' });
    expect(button.getAttribute('style')).not.toContain('left');
    expect(getComputedStyle(button).position).not.toBe('fixed');
  });

  it('marks a saved annotation with its order', () => {
    const open = vi.fn();
    render(<GlyphCommentButton open={open} order={3} position={{ x: 120, y: 40 }} />);

    const marker = screen.getByRole('button', { name: 'Edit annotation 3' });
    expect(marker.textContent).toBe('3');
    expect(marker.style.left).toBe('120px');
    expect(marker.style.top).toBe('40px');
    expect(fireEvent.mouseDown(marker)).toBe(false);
    fireEvent.click(marker);

    expect(open).toHaveBeenCalledOnce();
  });

  it('marks an annotation inline when it has no position', () => {
    render(<GlyphCommentButton open={vi.fn()} order={2} />);

    expect(screen.getByRole('button', { name: 'Edit annotation 2' }).getAttribute('style')).not.toContain('left');
  });
});
