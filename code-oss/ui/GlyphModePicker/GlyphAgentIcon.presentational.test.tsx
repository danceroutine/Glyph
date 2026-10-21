import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { GlyphAgentIcon } from '#code-oss/ui/GlyphModePicker/GlyphAgentIcon.presentational.tsx';

afterEach(cleanup);

describe(GlyphAgentIcon, () => {
  it('draws a decorative pair of sparkles', () => {
    const { container } = render(<GlyphAgentIcon />);

    const icon = container.firstElementChild as HTMLElement;
    expect(icon.classList.contains('glyph-agent-icon')).toBe(true);
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect([...icon.querySelectorAll('svg')].map(svg => svg.getAttribute('width'))).toEqual(['11', '6']);
  });
});
