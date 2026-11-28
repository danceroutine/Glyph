import { renderHook } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { useGlyphMarkdownState } from '#code-oss/ui/GlyphMarkdown/useGlyphMarkdownState.ts';

describe(useGlyphMarkdownState, () => {
  it('parses markdown into block tokens', () => {
    const { result } = renderHook(useGlyphMarkdownState, { initialProps: '# Title\n\nBody' });

    expect(result.current.map(token => token.type)).toEqual(['heading', 'space', 'paragraph']);
  });

  it('reuses the parsed tokens until the text changes', () => {
    const { result, rerender } = renderHook(useGlyphMarkdownState, { initialProps: 'first' });
    const first = result.current;

    rerender('first');
    expect(result.current).toBe(first);

    rerender('second');
    expect(result.current).not.toBe(first);
    expect(result.current[0]?.raw).toBe('second');
  });
});
