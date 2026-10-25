import { FileText, TriangleAlert } from 'lucide-preact';
import type { GlyphInstructionSource } from '#src/desktop/protocol/events/GlyphInstructionSource.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    height: '100%',
    overflow: 'auto',
    color: tokens.text.primary,
  }),
  content: css({
    width: 'min(760px, calc(100% - 48px))',
    margin: '0 auto',
    padding: '28px 24px 48px',
    boxSizing: 'border-box',
  }),
  heading: css({ margin: '0 0 8px', fontSize: 22, fontWeight: tokens.font.weight.semibold }),
  description: css({ margin: '0 0 24px', color: tokens.text.muted, lineHeight: 1.5 }),
  empty: css({ padding: '24px 0', color: tokens.text.muted }),
  source: css({
    padding: '14px 0',
    borderTop: tokens.border.default,
    ':last-child': { borderBottom: tokens.border.default },
  }),
  path: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    maxWidth: '100%',
    padding: '2px 0',
    border: 0,
    color: 'var(--vscode-textLink-foreground)',
    background: 'transparent',
    font: 'inherit',
    fontWeight: tokens.font.weight.semibold,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover span': { textDecoration: 'underline' },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
  }),
  errorPath: css({ color: tokens.text.error }),
  pathText: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  metadata: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 16px',
    margin: '7px 0 0 24px',
    color: tokens.text.muted,
  }),
  kind: css({
    color: 'var(--vscode-badge-foreground)',
    background: 'var(--vscode-badge-background)',
    borderRadius: tokens.badge.radius,
    padding: '1px 6px',
    fontSize: 11,
    lineHeight: '16px',
  }),
  scope: css({ lineHeight: '18px' }),
  message: css({ margin: '8px 0 0 24px', color: tokens.text.error, lineHeight: 1.4 }),
};

export interface GlyphAgentInstructionsProps {
  readonly sources: readonly GlyphInstructionSource[];
  readonly query?: string;
  readonly openSource: (source: GlyphInstructionSource) => void;
}

/** Searchable, provider-neutral presentation of workspace instruction sources. */
export function GlyphAgentInstructions({ sources, query = '', openSource }: GlyphAgentInstructionsProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = sources.filter(source => matches(source, normalizedQuery));
  return (
    <section class={`glyph-agent-instructions-settings ${styles.root}`} aria-labelledby="glyph-instructions-heading">
      <div class={styles.content}>
        <h2 class={styles.heading} id="glyph-instructions-heading">
          Agent Instructions
        </h2>
        <p class={styles.description}>
          Instruction files active in this workspace. A file applies to its directory and descendants; nearer files take
          precedence.
        </p>
        {visible.length === 0 ? (
          <p class={styles.empty}>
            {normalizedQuery
              ? 'No instruction files match your search.'
              : 'No active instruction files were found in this workspace.'}
          </p>
        ) : (
          visible.map(source => (
            <article class={`instruction-source ${styles.source}`} data-status={source.status} key={source.id}>
              <button
                class={`source-path ${styles.path} ${source.status === 'error' ? styles.errorPath : ''}`}
                type="button"
                title={`Open ${source.path}`}
                onClick={() => {
                  openSource(source);
                }}
              >
                {source.status === 'error' ? (
                  <TriangleAlert size={16} aria-hidden="true" />
                ) : (
                  <FileText size={16} aria-hidden="true" />
                )}
                <span class={`path ${styles.pathText}`}>{source.path}</span>
              </button>
              <div class={`source-metadata ${styles.metadata}`}>
                <span class={`kind ${styles.kind}`}>{source.label}</span>
                <span class={`scope ${styles.scope}`}>
                  Applies to {source.scope === '.' ? 'the workspace' : `${source.scope}/**`}
                </span>
              </div>
              {source.message && <p class={`source-message ${styles.message}`}>{source.message}</p>}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function matches(source: GlyphInstructionSource, query: string): boolean {
  if (!query) return true;
  return [source.path, source.scope, source.label, source.status, source.message]
    .filter((value): value is string => value !== undefined)
    .some(value => value.toLocaleLowerCase().includes(query));
}
