import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { GlyphToolDisclosure } from '#code-oss/ui/GlyphTurnProgress/GlyphToolDisclosure.tsx';

afterEach(cleanup);

describe(GlyphToolDisclosure, () => {
  it('discloses its content under a labeled summary', () => {
    const { container } = render(
      <GlyphToolDisclosure label="Read file" class="custom" icon={<i data-icon />}>
        <p>Details</p>
      </GlyphToolDisclosure>,
    );

    const details = container.querySelector('details')!;
    expect(details.className).toBe('custom');
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.getAttribute('title')).toBe('Read file');
    expect(summary.textContent).toBe('Read file');
    expect(summary.querySelector('[data-icon]')).toBeTruthy();
    expect(summary.querySelector('.glyph-tool-chevron')).toBeTruthy();
    expect(details.querySelector('p')?.textContent).toBe('Details');
  });

  it('shows a prefix and a distinct running treatment', () => {
    const { container } = render(
      <>
        <GlyphToolDisclosure label="2 tools" prefix="Exploring" running>
          {null}
        </GlyphToolDisclosure>
        <GlyphToolDisclosure label="2 tools">{null}</GlyphToolDisclosure>
      </>,
    );

    const [running, idle] = [...container.querySelectorAll('summary')];
    expect(running!.textContent).toBe('Exploring2 tools');
    expect(idle!.textContent).toBe('2 tools');
    expect(running!.className).not.toBe(idle!.className);
  });
});
