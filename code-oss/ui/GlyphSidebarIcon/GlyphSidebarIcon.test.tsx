import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { GlyphSidebarIcon } from '#code-oss/ui/GlyphSidebarIcon/GlyphSidebarIcon.tsx';

afterEach(cleanup);

describe(GlyphSidebarIcon, () => {
  it('draws a decorative window with a right sidebar', () => {
    const { container } = render(<GlyphSidebarIcon />);

    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('viewBox')).toBe('0 0 18 18');
    expect(svg.querySelectorAll('rect')).toHaveLength(2);
  });
});
