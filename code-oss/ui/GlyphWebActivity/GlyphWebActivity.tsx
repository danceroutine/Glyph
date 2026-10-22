import { Globe } from 'lucide-preact';
import { GlyphToolDisclosure } from '#code-oss/ui/GlyphTurnProgress/GlyphToolDisclosure.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import { webToolResultSchema } from '#src/web/WebToolResult.js';
import { WebToolName } from '#src/web/WebToolName.js';
import { GlyphToolIcon } from '#code-oss/ui/GlyphTurnProgress/GlyphToolIcon.tsx';
import { GlyphToolActivityStatus, type GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { isEnumValue } from '#src/shared/validators/isEnumValue.js';
import { isRecord } from '#src/shared/validators/isRecord.js';

const styles = {
  body: css({
    margin: '6px 0 8px',
    border: tokens.border.default,
    borderRadius: 8,
    padding: '8px 10px',
    maxHeight: 320,
    overflowY: 'auto',
  }),
  sources: css({ listStyle: 'none', margin: 0, padding: 0 }),
  link: css({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '6px 0',
    color: tokens.text.primary,
    textDecoration: 'none',
    ':hover': { textDecoration: 'underline' },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
    '& > svg': { flexShrink: 0, marginTop: 2, color: tokens.text.muted },
  }),
  source: css({ display: 'flex', flexDirection: 'column', minWidth: 0, overflowWrap: 'anywhere' }),
  snippet: css({ fontSize: tokens.font.size.detail, color: tokens.text.muted }),
  error: css({ color: tokens.text.error, fontSize: tokens.font.size.detail }),
};

export function webToolName(tool: GlyphToolActivity): WebToolName | undefined {
  return isEnumValue(WebToolName, tool.name) ? tool.name : undefined;
}

export function isWebTool(tool: GlyphToolActivity): boolean {
  return webToolName(tool) !== undefined;
}

export function webActivityResult(tool: GlyphToolActivity) {
  try {
    const result = webToolResultSchema.safeParse(JSON.parse(tool.summary ?? '{}'));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function GlyphWebActivity({
  tool,
  active,
  openLink,
}: {
  readonly tool: GlyphToolActivity;
  readonly active: boolean;
  readonly openLink?: ((href: string) => void) | undefined;
}) {
  let input: { query?: string; url?: string } = {};
  try {
    const parsed: unknown = JSON.parse(tool.arguments ?? '{}');
    if (isRecord(parsed)) {
      if (typeof parsed.query === 'string') input.query = parsed.query;
      if (typeof parsed.url === 'string') input.url = parsed.url;
    }
  } catch {
    /* Incomplete streamed arguments. */
  }
  const data = webActivityResult(tool);
  const search = webToolName(tool) === WebToolName.SEARCH;
  const running = active && tool.status === GlyphToolActivityStatus.STARTED;
  const failed = data?.kind === 'web_error' || tool.status === GlyphToolActivityStatus.FAILED;
  const interrupted =
    tool.status === GlyphToolActivityStatus.INTERRUPTED || (!active && tool.status === GlyphToolActivityStatus.STARTED);
  const label = `${interrupted ? 'Interrupted · ' : failed ? 'Failed · ' : ''}${search ? (running ? 'Searching web' : 'Searched web') : running ? 'Fetching page' : 'Fetched page'} ${search ? (input.query ?? '') : (input.url ?? '')}`;
  const sources =
    data?.kind === 'web_search'
      ? [
          {
            title: 'Web search results',
            url: data.searchUrl,
            snippet: data.results.length > 0 ? '' : 'No results found',
          },
          ...data.results,
        ]
      : data?.kind === 'web_fetch'
        ? [{ ...data.source, snippet: data.truncated ? 'Fetched page · content truncated' : 'Fetched page' }]
        : data?.kind === 'web_error' && data.source
          ? [
              {
                ...data.source,
                snippet: 'Open in your browser',
              },
            ]
          : [];
  return (
    <li data-tool-id={tool.id} aria-busy={running}>
      <GlyphToolDisclosure label={label} icon={<GlyphToolIcon web />} running={running}>
        <div class={styles.body}>
          {sources.length > 0 && (
            <ul class={styles.sources} aria-label={search ? 'Web search results' : 'Fetched page sources'}>
              {sources.map(item => (
                <li key={item.url}>
                  <a
                    class={styles.link}
                    href={item.url}
                    aria-label={item.title}
                    onClick={event => {
                      event.preventDefault();
                      if (/^https?:\/\//iu.test(item.url)) openLink?.(item.url);
                    }}
                  >
                    <Globe size={16} aria-hidden="true" />
                    <span class={styles.source}>
                      <span>{item.title}</span>
                      {item.snippet && <span class={styles.snippet}>{item.snippet}</span>}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {data?.kind === 'web_error' && (
            <div class={styles.error} role="status">
              {data.error.message}
            </div>
          )}
          {failed && data?.kind !== 'web_error' && (
            <div class={styles.error} role="status">
              {tool.summary !== undefined && tool.summary !== '' ? tool.summary : 'The web request failed.'}
            </div>
          )}
          {interrupted && <div role="status">Request cancelled</div>}
          {running && <div role="status">Waiting for the result…</div>}
          {sources.length === 0 && !running && !failed && !interrupted && (
            <div role="status">No details recorded for this call.</div>
          )}
        </div>
      </GlyphToolDisclosure>
    </li>
  );
}
