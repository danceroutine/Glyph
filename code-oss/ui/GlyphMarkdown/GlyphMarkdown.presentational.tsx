import { type MarkedToken, type Token, type Tokens } from 'marked';
import { decodeHTMLStrict } from 'entities';
import type { ComponentChildren } from 'preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const style = css({
  lineHeight: 1.6,
  whiteSpace: 'normal',
  '& > :first-child': { marginTop: 0 },
  '& > :last-child': { marginBottom: 0 },
  '& p': { margin: '8px 0' },
  '& h1': { fontSize: '1.5em', margin: '20px 0 10px' },
  '& h2': { fontSize: '1.3em', margin: '18px 0 8px' },
  '& h3': { fontSize: '1.1em', margin: '16px 0 8px' },
  '& ul, & ol': { paddingLeft: 24 },
  '& blockquote': {
    margin: '12px 0',
    paddingLeft: 12,
    borderLeft: `2px solid ${tokens.text.muted}`,
    color: tokens.text.muted,
  },
  overflowWrap: 'anywhere',
  '& code': { fontFamily: tokens.font.family.code },
  '& a': { color: tokens.context.file.foreground },
  '& table': { borderCollapse: 'collapse' },
  '& td, & th': { border: tokens.border.default, padding: tokens.space.sm },
});
export interface GlyphContextToken extends Tokens.Generic {
  readonly type: 'glyph_context';
  readonly index: number;
}

function isGlyphContextToken(token: Token): token is GlyphContextToken {
  return token.type === 'glyph_context';
}

const markedTokenTypes = new Set([
  'blockquote',
  'br',
  'checkbox',
  'code',
  'codespan',
  'def',
  'del',
  'em',
  'escape',
  'heading',
  'hr',
  'html',
  'image',
  'link',
  'list',
  'list_item',
  'paragraph',
  'space',
  'strong',
  'table',
  'tag',
  'text',
]);

function isMarkedToken(token: Token): token is MarkedToken {
  return markedTokenTypes.has(token.type);
}

/** Render tokens as elements; raw HTML and executable links are never interpreted. */
export function GlyphMarkdown({
  items,
  openLink,
  diagram,
  code,
  inline,
  text = value => value,
}: {
  readonly items: readonly Token[];
  readonly openLink: (href: string) => void;
  readonly text?: (value: string) => ComponentChildren;
  readonly inline?: (token: GlyphContextToken) => ComponentChildren;
  readonly code: (source: string, language: string | undefined) => ComponentChildren;
  readonly diagram: (source: string) => ComponentChildren;
}) {
  const childrenOf = (token: Token, decodeEntities: boolean): ComponentChildren => {
    if ('tokens' in token && token.tokens !== undefined)
      return render(token.tokens, decodeEntities && !(token.type === 'link' && token.autolink === true));
    if (!('text' in token)) return '';
    const value: unknown = token.text;
    if (typeof value !== 'string') return '';
    // Marked already decodes numeric entities in text. Start with
    // raw source so both numeric and named entities decode once.
    return text(
      token.type === 'text' && token.escaped !== true && decodeEntities ? decodeHTMLStrict(token.raw) : value,
    );
  };
  const render = (nodes: readonly Token[], decodeEntities = true): ComponentChildren =>
    nodes.map((token): ComponentChildren => {
      const children = childrenOf(token, decodeEntities);
      if (isGlyphContextToken(token)) return inline?.(token);
      if (!isMarkedToken(token)) return children;
      switch (token.type) {
        case 'heading':
          return token.depth === 1 ? (
            <h1>{children}</h1>
          ) : token.depth === 2 ? (
            <h2>{children}</h2>
          ) : (
            <h3>{children}</h3>
          );
        case 'paragraph':
          return <p>{children}</p>;
        case 'strong':
          return <strong>{children}</strong>;
        case 'em':
          return <em>{children}</em>;
        case 'del':
          return <del>{children}</del>;
        case 'codespan':
          return <code>{text(token.text)}</code>;
        case 'code':
          return token.lang?.trim().toLowerCase() === 'mermaid' ? diagram(token.text) : code(token.text, token.lang);
        case 'link':
          return (
            <a
              href="#"
              onClick={event => {
                event.preventDefault();
                openLink(token.autolink === true ? token.href : decodeHTMLStrict(token.href));
              }}
            >
              {children}
            </a>
          );
        case 'list':
          return token.ordered ? (
            <ol start={token.start === '' || token.start === 0 ? 1 : token.start}>
              {token.items.map((item: Token) => (
                <li>{'tokens' in item ? render(item.tokens ?? []) : ''}</li>
              ))}
            </ol>
          ) : (
            <ul>
              {token.items.map((item: Token) => (
                <li>{'tokens' in item ? render(item.tokens ?? []) : ''}</li>
              ))}
            </ul>
          );
        case 'checkbox':
          return <input type="checkbox" checked={token.checked} disabled aria-label="Task status" />;
        case 'table':
          return (
            <table>
              <thead>
                <tr>
                  {token.header.map((cell: Tokens.TableCell) => (
                    <th style={{ textAlign: cell.align ?? undefined }}>{render(cell.tokens)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row: Tokens.TableCell[]) => (
                  <tr>
                    {row.map(cell => (
                      <td style={{ textAlign: cell.align ?? undefined }}>{render(cell.tokens)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        case 'blockquote':
          return <blockquote>{children}</blockquote>;
        case 'br':
          return <br />;
        case 'hr':
          return <hr />;
        case 'space':
          return null;
        case 'image':
          return <span>{children}</span>;
        default:
          return children;
      }
    });
  return <div class={style}>{render(items)}</div>;
}
