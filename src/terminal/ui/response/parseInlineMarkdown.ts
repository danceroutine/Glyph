import { Lexer } from 'marked';
import type { Token, Tokens } from 'marked';
import { decodeHTMLStrict } from 'entities';

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

const inlineTokenTypes = new Set(['br', 'codespan', 'del', 'em', 'escape', 'html', 'image', 'link', 'strong', 'text']);

function isInlineToken(token: Token): token is InlineToken {
  return inlineTokenTypes.has(token.type);
}

/** Parses inline Markdown into the text and emphasis spans supported by Ink. */
export function parseInlineMarkdown(value: string): InlineMarkdownSegment[] {
  const segments: InlineMarkdownSegment[] = [];
  appendTokens(
    Lexer.lexInline(value).filter(child => isInlineToken(child)),
    false,
    segments,
  );
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
  decodeEntities = true,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
        appendTokens(
          token.tokens.filter(child => isInlineToken(child)),
          true,
          segments,
          decodeEntities,
        );
        break;
      case 'del':
      case 'em':
      case 'image':
        appendTokens(
          token.tokens.filter(child => isInlineToken(child)),
          inheritedStrong,
          segments,
          decodeEntities,
        );
        break;
      case 'link':
        appendTokens(
          token.tokens.filter(child => isInlineToken(child)),
          inheritedStrong,
          segments,
          decodeEntities && token.autolink !== true,
        );
        break;
      case 'br':
        appendSegment('\n', inheritedStrong, segments);
        break;
      case 'codespan':
      case 'escape':
      case 'html':
        appendSegment(token.text, inheritedStrong, segments);
        break;
      case 'text':
        // Marked decodes numeric references already; raw text avoids decoding twice.
        appendSegment(
          decodeEntities && token.escaped !== true ? decodeHTMLStrict(token.raw) : token.text,
          inheritedStrong,
          segments,
        );
        break;
    }
  }
}

function appendSegment(value: string, strong: boolean, segments: InlineMarkdownSegment[]): void {
  const previous = segments.at(-1);
  if (previous?.strong === strong) previous.value += value;
  else segments.push({ value, strong });
}
