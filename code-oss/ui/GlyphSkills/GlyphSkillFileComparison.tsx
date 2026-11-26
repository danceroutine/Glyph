import type { GlyphSkillPreview } from '#src/desktop/protocol/events/GlyphSkillManagement.js';
import { GlyphFileIcon } from '#code-oss/ui/GlyphFileIcon/GlyphFileIcon.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  file: css({ borderTop: tokens.border.default, '& summary': { padding: '10px 0', cursor: 'pointer' } }),
  path: css({ display: 'inline-flex', alignItems: 'center', gap: 8 }),
  contents: css({
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    padding: 12,
    maxHeight: 360,
    overflow: 'auto',
    fontFamily: tokens.font.family.code,
  }),
  before: css({ background: 'var(--vscode-diffEditor-removedTextBackground)' }),
  after: css({ background: 'var(--vscode-diffEditor-insertedTextBackground)' }),
};
/** Shared file comparison for Settings previews and one-shot agent package approvals. */
export function GlyphSkillFileComparison({ files }: { readonly files: GlyphSkillPreview['files'] }) {
  return (
    <div>
      {files.map(file => (
        <details class={styles.file} key={file.path} open={file.path === 'SKILL.md'}>
          <summary>
            <span class={styles.path}>
              <GlyphFileIcon path={file.path} />
              {file.path} {file.status && <small>({file.status})</small>}
            </span>
          </summary>
          {(['beforeInfo', 'afterInfo'] as const).map(side => {
            const info = file[side];
            return (
              info && (
                <p key={side}>
                  {side === 'beforeInfo' ? 'Before' : 'After'} · {info.encoding} · {info.size} bytes · mode{' '}
                  {info.mode.toString(8).padStart(4, '0')}
                  <br />
                  SHA-256 <code>{info.digest}</code>
                </p>
              )
            );
          })}
          {file.before !== undefined && (
            <pre class={`${styles.contents} ${styles.before}`} aria-label={`Before ${file.path}`}>
              {file.before}
            </pre>
          )}
          {file.after !== undefined && (
            <pre class={`${styles.contents} ${styles.after}`} aria-label={`After ${file.path}`}>
              {file.after}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}
