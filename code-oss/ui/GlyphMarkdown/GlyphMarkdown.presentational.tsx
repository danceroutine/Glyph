import { type Token, type Tokens } from 'marked';
import type { ComponentChildren } from 'preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const style = css({
  lineHeight: 1.6,
  overflowWrap: 'anywhere',
  '& pre': { overflow: 'auto', padding: tokens.space.md, background: tokens.input.background },
  '& code': { fontFamily: tokens.font.family.code },
  '& a': { color: tokens.context.file.foreground },
  '& table': { borderCollapse: 'collapse' },
  '& td, & th': { border: tokens.border.default, padding: tokens.space.sm },
});
/** Render tokens as elements; raw HTML and executable links are never interpreted. */
export function GlyphMarkdown({
  items,
  openLink,
  diagram,
}: {
  readonly items: readonly Token[];
  readonly openLink: (href: string) => void;
  readonly diagram: (source: string) => ComponentChildren;
}) {
  const render = (items: readonly Token[]): ComponentChildren =>
    items.map((token): ComponentChildren => {
      const children = 'tokens' in token && token.tokens ? render(token.tokens) : 'text' in token ? token.text : '';
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
          return <code>{token.text}</code>;
        case 'code':
          return token.lang === 'mermaid' ? (
            diagram(token.text)
          ) : (
            <pre>
              <code>{token.text}</code>
            </pre>
          );
        case 'link':
          return (
            <a
              href="#"
              onClick={event => {
                event.preventDefault();
                openLink(token.href);
              }}
            >
              {children}
            </a>
          );
        case 'list':
          return token.ordered ? (
            <ol>
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
          return <span>{token.text}</span>;
        default:
          return children;
      }
    });
  return <div class={style}>{render(items)}</div>;
}
