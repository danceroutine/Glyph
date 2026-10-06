import { Lexer } from 'marked';
import type { Tokens } from 'marked';

export interface InlineMarkdownSegment {
  value: string;
  strong: boolean;
}

type InlineToken =
  | Tokens.Br
  | Tokens.Codespan
  | Tokens.Del
  | Tokens.Em
  | Tokens.Escape
  | Tokens.HTML
  | Tokens.Image
  | Tokens.Link
  | Tokens.Strong
  | Tokens.Text;

/** Parses inline Markdown into the text and emphasis spans supported by Ink. */
export function parseInlineMarkdown(value: string): InlineMarkdownSegment[] {
  const segments: InlineMarkdownSegment[] = [];
  appendTokens(Lexer.lexInline(value) as InlineToken[], false, segments);
  return segments.length > 0 ? segments : [{ value: '', strong: false }];
}

export function inlineMarkdownText(value: string): string {
  return parseInlineMarkdown(value)
    .map(segment => segment.value)
    .join('');
}

function appendTokens(
  tokens: readonly InlineToken[],
  inheritedStrong: boolean,
  segments: InlineMarkdownSegment[],
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        appendTokens(token.tokens as InlineToken[], true, segments);
        break;
      case 'del':
      case 'em':
      case 'link':
        appendTokens(token.tokens as InlineToken[], inheritedStrong, segments);
        break;
      case 'br':
        appendSegment('\n', inheritedStrong, segments);
        break;
      case 'codespan':
      case 'escape':
      case 'html':
      case 'image':
      case 'text':
        appendSegment(token.text, inheritedStrong, segments);
        break;
    }
  }
}

function appendSegment(value: string, strong: boolean, segments: InlineMarkdownSegment[]): void {
  if (!value) return;
  const previous = segments.at(-1);
  if (previous?.strong === strong) previous.value += value;
  else segments.push({ value, strong });
}
