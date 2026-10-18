import { useMemo } from 'preact/hooks';
import { marked } from 'marked';
export function useGlyphMarkdownState(text: string) {
  return useMemo(() => marked.lexer(text), [text]);
}
