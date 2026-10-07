import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import { Lexer } from 'marked';
import type { Tokens } from 'marked';
import stringWidth from 'string-width';
import { sanitizeText } from '../shared/sanitizeText.ts';
import { inlineMarkdownText } from './parseInlineMarkdown.ts';

export interface MarkdownProps {
  value: string;
}

type BlockToken =
  | Tokens.Blockquote
  | Tokens.Code
  | Tokens.Def
  | Tokens.Heading
  | Tokens.Hr
  | Tokens.HTML
  | Tokens.List
  | Tokens.Paragraph
  | Tokens.Space
  | Tokens.Table;

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

/** Renders the Markdown block and inline structures supported by terminal chat. */
export function Markdown({ value }: MarkdownProps): ReactElement {
  return <MarkdownBlocks tokens={Lexer.lex(value) as BlockToken[]} />;
}

function MarkdownBlocks({ tokens }: { tokens: readonly BlockToken[] }): ReactElement {
  return <Box flexDirection="column">{tokens.map((token, index) => renderBlock(token, index))}</Box>;
}

function renderBlock(token: BlockToken, key: number): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null;
    case 'heading':
      return (
        <Text key={key} bold color="cyan">
          <InlineTokens tokens={token.tokens as InlineToken[]} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text key={key} color="white">
          <InlineTokens tokens={token.tokens as InlineToken[]} />
        </Text>
      );
    case 'list': {
      const start = typeof token.start === 'number' ? token.start : 1;
      return (
        <Box key={key} flexDirection="column">
          {token.items.map((item, index) => {
            const marker = item.task ? `[${item.checked ? 'x' : ' '}]` : token.ordered ? `${start + index}.` : '-';
            return (
              <Text key={index} color="white">
                {`${marker} `}
                <InlineTokens tokens={Lexer.lexInline(item.text) as InlineToken[]} />
              </Text>
            );
          })}
        </Box>
      );
    }
    case 'blockquote':
      return (
        <Box
          key={key}
          borderBottom={false}
          borderColor="gray"
          borderLeft
          borderRight={false}
          borderStyle="single"
          borderTop={false}
          paddingLeft={1}
        >
          <MarkdownBlocks tokens={token.tokens as BlockToken[]} />
        </Box>
      );
    case 'code':
      return (
        <Box key={key} backgroundColor="#3a3a3a" flexDirection="column" paddingX={1}>
          <Text color="white">{sanitizeText(token.text)}</Text>
        </Box>
      );
    case 'table':
      return <MarkdownTable key={key} table={token} />;
    case 'hr':
      return (
        <Text key={key} dimColor>
          {'─'.repeat(24)}
        </Text>
      );
    case 'html':
      return <Text key={key}>{sanitizeText(token.text.replace(/<[^>]*>/gu, ''))}</Text>;
  }
}

function InlineTokens({ tokens }: { tokens: readonly InlineToken[] }): ReactElement {
  return <>{tokens.map((token, index) => renderInline(token, index))}</>;
}

function renderInline(token: InlineToken, key: number): ReactNode {
  switch (token.type) {
    case 'strong':
      return (
        <Text key={key} bold>
          <InlineTokens tokens={token.tokens as InlineToken[]} />
        </Text>
      );
    case 'em':
      return (
        <Text key={key} italic>
          <InlineTokens tokens={token.tokens as InlineToken[]} />
        </Text>
      );
    case 'del':
      return (
        <Text key={key} strikethrough>
          <InlineTokens tokens={token.tokens as InlineToken[]} />
        </Text>
      );
    case 'link':
      return (
        <Text key={key} underline>
          <InlineTokens tokens={token.tokens as InlineToken[]} />
        </Text>
      );
    case 'codespan':
      return (
        <Text key={key} color="cyan">
          {sanitizeText(token.text)}
        </Text>
      );
    case 'image':
      return (
        <Text key={key} dimColor>
          {sanitizeText(token.text)}
        </Text>
      );
    case 'br':
      return '\n';
    case 'html':
      return null;
    case 'escape':
      return sanitizeText(token.text);
    case 'text':
      return sanitizeText(token.text);
  }
}

function MarkdownTable({ table }: { table: Tokens.Table }): ReactElement {
  const rows = [table.header, ...table.rows].map(row => row.map(cell => sanitizeText(inlineMarkdownText(cell.text))));
  const widths = table.header.map((_, column) => Math.max(...rows.map(row => stringWidth(row[column]!))));
  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map(width => '─'.repeat(width + 2)).join(middle)}${right}`;
  const rowText = (row: readonly string[]): string =>
    `│${row.map((cell, column) => ` ${cell}${' '.repeat(widths[column]! - stringWidth(cell))} `).join('│')}│`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{border('┌', '┬', '┐')}</Text>
      <Text bold>{rowText(rows[0]!)}</Text>
      <Text dimColor>{border('├', '┼', '┤')}</Text>
      {rows.slice(1).map((row, index) => (
        <Text key={index}>{rowText(row)}</Text>
      ))}
      <Text dimColor>{border('└', '┴', '┘')}</Text>
    </Box>
  );
}
