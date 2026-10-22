import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { marked, type Token } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphMarkdown } from '#code-oss/ui/GlyphMarkdown/GlyphMarkdown.presentational.tsx';

afterEach(cleanup);

const renderMarkdown = (items: readonly Token[], overrides: Partial<Parameters<typeof GlyphMarkdown>[0]> = {}) =>
  render(
    <GlyphMarkdown
      items={items}
      openLink={vi.fn()}
      code={(source, language) => <pre data-language={language ?? 'none'}>{source}</pre>}
      diagram={source => <figure>{source}</figure>}
      {...overrides}
    />,
  );

describe(GlyphMarkdown, () => {
  it('renders three levels of headings', () => {
    const { container } = renderMarkdown(marked.lexer('# One\n\n## Two\n\n### Three\n\n#### Four'));

    expect(container.querySelector('h1')?.textContent).toBe('One');
    expect(container.querySelector('h2')?.textContent).toBe('Two');
    expect([...container.querySelectorAll('h3')].map(heading => heading.textContent)).toEqual(['Three', 'Four']);
  });

  it('renders inline formatting, images as their text, line breaks and rules', () => {
    const { container } = renderMarkdown(
      marked.lexer('**bold** *italic* ~~gone~~ `code` ![alt text](image.png)\nline  \nbreak\n\n---'),
    );

    expect(container.querySelector('p strong')?.textContent).toBe('bold');
    expect(container.querySelector('p em')?.textContent).toBe('italic');
    expect(container.querySelector('p del')?.textContent).toBe('gone');
    expect(container.querySelector('p code')?.textContent).toBe('code');
    expect(container.querySelector('p span')?.textContent).toBe('alt text');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('p br')).toBeTruthy();
    expect(container.querySelector('hr')).toBeTruthy();
  });

  it('decodes named and numeric entities exactly once', () => {
    const { container } = renderMarkdown(marked.lexer('Tom &amp; Jerry &#169; &amp;amp;'));

    expect(container.querySelector('p')?.textContent).toBe('Tom & Jerry © &amp;');
  });

  it('keeps already escaped text verbatim', () => {
    const { container } = renderMarkdown([
      {
        type: 'paragraph',
        raw: '&amp;',
        text: '&amp;',
        tokens: [{ type: 'text', raw: '&amp;', text: '&amp;', escaped: true }],
      },
    ]);

    expect(container.querySelector('p')?.textContent).toBe('&amp;');
  });

  it('shows raw HTML as literal text', () => {
    const { container } = renderMarkdown(marked.lexer('<b>bold</b> \\*'));

    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('<b>bold</b> *');
  });

  it('passes text through a custom text renderer', () => {
    const { container } = renderMarkdown(marked.lexer('hello `world`'), {
      text: value => <mark>{value}</mark>,
    });

    expect([...container.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['hello ', 'world']);
  });

  it('renders Mermaid blocks as diagrams and other blocks as code', () => {
    const { container } = renderMarkdown(
      marked.lexer('```Mermaid \ngraph TD\n```\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```\n\n    indented'),
    );

    expect(container.querySelector('figure')?.textContent).toBe('graph TD');
    expect([...container.querySelectorAll('pre')].map(pre => [pre.dataset.language, pre.textContent])).toEqual([
      ['ts', 'const a = 1;'],
      ['', 'plain'],
      ['none', 'indented'],
    ]);
  });

  it('opens links through the host with their decoded destination', () => {
    const openLink = vi.fn();
    renderMarkdown(marked.lexer('[docs](https://example.com/?a&amp;b)'), { openLink });

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link.getAttribute('href')).toBe('#');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openLink).toHaveBeenCalledWith('https://example.com/?a&b');
  });

  it('opens and shows autolinks exactly as written', () => {
    const openLink = vi.fn();
    renderMarkdown(marked.lexer('<https://example.com/a&amp;b>'), { openLink });

    const link = screen.getByRole('link', { name: 'https://example.com/a&amp;b' });
    fireEvent.click(link);

    expect(openLink).toHaveBeenCalledWith('https://example.com/a&amp;b');
  });

  it('renders ordered lists from their starting number', () => {
    const { container } = renderMarkdown(marked.lexer('3. three\n4. four\n\nsplit\n\n0. zero'));

    const lists = container.querySelectorAll('ol');
    expect(lists[0]?.getAttribute('start')).toBe('3');
    expect([...lists[0]!.querySelectorAll('li')].map(item => item.textContent)).toEqual(['three', 'four']);
    expect(lists[1]?.getAttribute('start')).toBe('1');
  });

  it('renders task lists with read-only checkboxes', () => {
    renderMarkdown(marked.lexer('- [x] done\n- [ ] todo'));

    const boxes = screen.getAllByRole('checkbox', { name: 'Task status' }) as HTMLInputElement[];
    expect(boxes.map(box => [box.checked, box.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['done', 'todo']);
  });

  it('renders list items without content as empty entries', () => {
    const { container } = renderMarkdown([
      {
        type: 'list',
        raw: '',
        ordered: true,
        start: 1,
        loose: false,
        items: [
          { type: 'list_item', raw: '', task: false, loose: false, text: '', tokens: undefined },
          { type: 'space', raw: '' },
        ],
      },
      {
        type: 'list',
        raw: '',
        ordered: false,
        start: '',
        loose: false,
        items: [
          { type: 'list_item', raw: '', task: false, loose: false, text: '', tokens: undefined },
          { type: 'space', raw: '' },
        ],
      },
    ]);

    expect([...container.querySelectorAll('ol li')].map(item => item.textContent)).toEqual(['', '']);
    expect([...container.querySelectorAll('ul li')].map(item => item.textContent)).toEqual(['', '']);
  });

  it('renders tables with their column alignment', () => {
    const { container } = renderMarkdown(marked.lexer('| a | b |\n|:-|-|\n| 1 | 2 |'));

    const headers = [...container.querySelectorAll('th')];
    expect(headers.map(cell => [cell.textContent, cell.style.textAlign])).toEqual([
      ['a', 'left'],
      ['b', ''],
    ]);
    const cells = [...container.querySelectorAll('td')];
    expect(cells.map(cell => [cell.textContent, cell.style.textAlign])).toEqual([
      ['1', 'left'],
      ['2', ''],
    ]);
  });

  it('renders block quotes and skips blank space', () => {
    const { container } = renderMarkdown(marked.lexer('> quoted\n\n\n\nafter'));

    expect(container.querySelector('blockquote')?.textContent).toBe('quoted');
    expect(container.firstElementChild?.childElementCount).toBe(2);
  });

  it('renders context references through the inline renderer when one is provided', () => {
    const reference = { type: 'glyph_context', raw: '@file', text: 'file' } as unknown as Token;
    const withInline = renderMarkdown([reference], { inline: token => <kbd>{token.raw}</kbd> });

    expect(withInline.container.querySelector('kbd')?.textContent).toBe('@file');

    cleanup();
    const withoutInline = renderMarkdown([reference]);

    expect(withoutInline.container.firstElementChild?.textContent).toBe('');
  });

  it('renders the text of tokens whose children are missing', () => {
    const { container } = renderMarkdown([
      { type: 'strong', raw: '**x**', text: 'fallback', tokens: undefined } as unknown as Token,
    ]);

    expect(container.querySelector('strong')?.textContent).toBe('fallback');
  });
});
