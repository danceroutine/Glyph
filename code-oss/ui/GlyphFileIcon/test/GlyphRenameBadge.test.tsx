import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { GlyphRenameBadge } from '#code-oss/ui/GlyphFileIcon/GlyphRenameBadge.tsx';

afterEach(cleanup);

describe(GlyphRenameBadge, () => {
  it('marks a file as renamed', () => {
    render(<GlyphRenameBadge />);

    const badge = screen.getByLabelText('Renamed');
    expect(badge.textContent).toBe('R');
    expect(badge.getAttribute('title')).toBe('Renamed');
  });
});
