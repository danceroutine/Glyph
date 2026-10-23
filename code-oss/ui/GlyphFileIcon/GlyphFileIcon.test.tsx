import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphFileIcon, GlyphFileIcons } from '#code-oss/ui/GlyphFileIcon/GlyphFileIcon.tsx';

afterEach(cleanup);

describe(GlyphFileIcon, () => {
  it('uses the themed icon classes provided by the host', () => {
    const resolve = vi.fn(() => ['file-icon', 'ts-ext-file-icon']);

    const { container } = render(
      <GlyphFileIcons.Provider value={resolve}>
        <GlyphFileIcon path="src/app.ts" />
      </GlyphFileIcons.Provider>,
    );

    expect(resolve).toHaveBeenCalledWith('src/app.ts');
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toBe('file-icon-themable-tree show-file-icons');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.firstElementChild!.classList.contains('ts-ext-file-icon')).toBe(true);
  });

  it.each([
    ['config.JSON', 'lucide-file-braces'],
    ['README.md', 'lucide-file-text'],
    ['notes.txt', 'lucide-file-text'],
    ['output.log', 'lucide-file-text'],
    ['main.rs', 'lucide-file-code'],
  ])('falls back to a generic icon for %s', (path, icon) => {
    const { container } = render(<GlyphFileIcon path={path} />);

    const svg = container.querySelector('svg')!;
    expect(svg.classList.contains(icon)).toBe(true);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
