import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WiredGlyphCodeBlock } from '#code-oss/ui/GlyphCodeBlock/GlyphCodeBlock.wired.tsx';
import { highlighted } from '#code-oss/ui/GlyphCodeBlock/GlyphCodeBlock.presentational.tsx';

afterEach(cleanup);

describe(WiredGlyphCodeBlock, () => {
  it('shows highlighted code with its language', () => {
    const { container } = render(<WiredGlyphCodeBlock source="const answer = 42;" language="ts" />);

    const code = screen.getByLabelText('ts code');
    expect(code.textContent).toBe('const answer = 42;');
    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code.style.whiteSpace).toBe('pre');
    expect(code.style.overflowWrap).toBe('normal');
    expect(container.querySelector('[data-language="ts"]')).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Code block controls' })).toBeTruthy();
  });

  it('shows unknown languages verbatim', () => {
    render(<WiredGlyphCodeBlock source="<b>raw</b>" language="unknown-lang" />);

    const code = screen.getByLabelText('unknown-lang code');
    expect(code.textContent).toBe('<b>raw</b>');
    expect(code.querySelector('b')).toBeNull();
  });

  it('toggles text wrapping', () => {
    render(<WiredGlyphCodeBlock source="x" />);
    const wrap = screen.getByRole('button', { name: 'Wrap code' });
    expect(wrap.title).toBe('Enable text wrap');

    fireEvent.click(wrap);

    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(wrap.title).toBe('Disable text wrap');
    const code = screen.getByLabelText('text code');
    expect(code.style.whiteSpace).toBe('pre-wrap');
    expect(code.style.overflowWrap).toBe('anywhere');
  });

  it('confirms a successful copy', async () => {
    const copyText = vi.fn(async () => {});
    render(<WiredGlyphCodeBlock source="ls" language="bash" copyText={copyText} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(await screen.findByRole('button', { name: 'Copied code' })).toBeTruthy();
    expect(copyText).toHaveBeenCalledWith('ls');
  });

  it('invites a retry after a failed copy', async () => {
    const copyText = vi.fn(async () => {
      throw new Error('denied');
    });
    render(<WiredGlyphCodeBlock source="ls" copyText={copyText} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed. Try again' })).toBeTruthy());
  });
});

describe(highlighted, () => {
  it('keeps text, nests classed spans and drops other nodes', () => {
    const { container } = render(
      <code>
        {highlighted([
          { type: 'text', value: 'a' },
          {
            type: 'element',
            tagName: 'span',
            properties: { className: ['hljs-string', 'extra'] },
            children: [{ type: 'text', value: 'b' }],
          },
          { type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: 'c' }] },
          { type: 'comment', value: 'hidden' } as never,
        ])}
      </code>,
    );

    expect(container.textContent).toBe('abc');
    const spans = container.querySelectorAll('span');
    expect(spans[0]!.className).toBe('hljs-string extra');
    expect(spans[1]!.hasAttribute('class')).toBe(false);
  });
});
