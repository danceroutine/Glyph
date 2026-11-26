import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphContextBadge } from '#code-oss/ui/GlyphContextBadge/GlyphContextBadge.presentational.tsx';

afterEach(cleanup);

describe(GlyphContextBadge, () => {
  it('offers a preview of a file with a file icon', () => {
    const click = vi.fn();
    render(<GlyphContextBadge label="main.ts" title="src/main.ts" onClick={click} />);

    const badge = screen.getByRole('button', { name: 'Preview src/main.ts' });
    fireEvent.click(badge);

    expect(badge.textContent).toBe('main.ts');
    expect(badge.title).toBe('src/main.ts');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(click).toHaveBeenCalledOnce();
  });

  it('marks skills with a slash instead of a file icon', () => {
    render(<GlyphContextBadge label="review" title="Review skill" skill actionLabel="Open" />);

    const badge = screen.getByRole('button', { name: 'Open Review skill' });
    expect(badge.textContent).toBe('/review');
    expect(badge.querySelector('svg')).toBeNull();
  });
});
