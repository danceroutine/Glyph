import { GlyphRenameBadge } from '#code-oss/ui/GlyphFileIcon/GlyphRenameBadge.tsx';
import { highlighted } from '#code-oss/ui/GlyphCodeBlock/GlyphCodeBlock.presentational.tsx';
import { highlightGlyphCode } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxHighlighting.ts';
import { glyphSyntaxStyles } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxStyles.ts';
import { GlyphFileIcon } from '#code-oss/ui/GlyphFileIcon/GlyphFileIcon.tsx';
import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import type { GlyphProposalFileSummary } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const styles = {
  card: css({ margin: '12px 0', border: tokens.border.default, borderRadius: tokens.input.radius, overflow: 'hidden' }),
  header: css({
    '&&': { width: '100%', justifyContent: 'flex-start', padding: '8px 12px', borderRadius: 0 },
    overflow: 'hidden',
  }),
  name: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  code: css({
    margin: 0,
    overflow: 'hidden',
    maxHeight: 160,
    fontFamily: tokens.font.family.code,
    lineHeight: 1.6,
    maskImage: 'linear-gradient(black 75%, transparent)',
  }),
  line: css({ display: 'flex', gap: 12, paddingInline: 12 }),
  number: css({ width: '3ch', textAlign: 'right', color: tokens.text.muted, userSelect: 'none' }),
};
export function GlyphFileChanges({
  files,
  review,
}: {
  readonly files: readonly GlyphProposalFileSummary[];
  readonly review: (fileId: string) => void;
}) {
  return (
    <>
      {files
        .filter(file => file.operation !== undefined && file.operation !== 'UPDATE')
        .map(file => {
          const removed = file.operation === 'DELETE';
          const created = file.operation === 'CREATE';
          const text = removed ? file.beforePreview : file.afterPreview;
          return (
            <section class={styles.card} aria-label={`File change ${file.path}`} key={file.id}>
              <Button
                appearance={ButtonAppearance.GHOST}
                class={styles.header}
                title={file.path}
                onClick={() => {
                  review(file.id);
                }}
              >
                <GlyphFileIcon path={file.path} />
                <span class={styles.name}>{file.path.split('/').at(-1)}</span>
                {file.operation === 'RENAME' && <GlyphRenameBadge />}
                {(file.additions ?? 0) > 0 && <span style={{ color: tokens.diff.added }}>+{file.additions}</span>}
                {(file.deletions ?? 0) > 0 && <span style={{ color: tokens.diff.removed }}>−{file.deletions}</span>}
              </Button>
              {text !== undefined && text !== '' && (
                <pre
                  class={styles.code}
                  style={{
                    background: removed
                      ? 'var(--vscode-diffEditor-removedTextBackground, #ff000022)'
                      : created
                        ? 'var(--vscode-diffEditor-insertedTextBackground, #00ff0022)'
                        : 'transparent',
                  }}
                >
                  {text.split('\n').map((line, index) => (
                    <div class={styles.line} key={index}>
                      <span class={styles.number}>{index + 1}</span>
                      <span aria-hidden="true">{removed ? '−' : created ? '+' : ' '}</span>
                      <code class={glyphSyntaxStyles}>
                        {highlighted(
                          highlightGlyphCode(
                            line || ' ',
                            (
                              { ts: 'typescript', js: 'javascript', md: 'markdown', json: 'json' } as Record<
                                string,
                                string
                              >
                            )[file.path.split('.').at(-1)!] ?? file.path.split('.').at(-1),
                          ) ?? [{ type: 'text', value: line || ' ' }],
                        )}
                      </code>
                    </div>
                  ))}
                </pre>
              )}
            </section>
          );
        })}
    </>
  );
}
