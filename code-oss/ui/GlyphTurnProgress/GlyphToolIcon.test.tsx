import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { GlyphToolIcon } from '#code-oss/ui/GlyphTurnProgress/GlyphToolIcon.tsx';

afterEach(cleanup);

describe(GlyphToolIcon, () => {
  it('shows a decorative wrench for general tools', () => {
    const { container } = render(<GlyphToolIcon />);

    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.lucide-wrench')).toBeTruthy();
  });

  it('shows a globe for web tools', () => {
    const { container } = render(<GlyphToolIcon web />);

    expect(container.querySelector('.lucide-globe')).toBeTruthy();
  });
});
