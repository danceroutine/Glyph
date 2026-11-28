import type { GlyphSkillPreview } from '#src/desktop/protocol/events/GlyphSkillManagement.js';
import { escapeDisplayControls } from '#src/shared/presentation/escapeDisplayControls.js';
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
export function GlyphSkillFileComparison({
  files,
  directories,
  createdParentDirectories,
}: Pick<GlyphSkillPreview, 'files' | 'directories' | 'createdParentDirectories'>) {
  return (
    <div>
      {createdParentDirectories?.map(path => (
        <div class={styles.file} key={path}>
          Create installation directory {escapeDisplayControls(path, true)}/
        </div>
      ))}
      {directories?.map(directory => (
        <div class={styles.file} key={directory.path}>
          {escapeDisplayControls(directory.path, true)}/ <small>({directory.status})</small>
          {directory.beforeMode !== undefined && (
            <p>Before · directory · mode {directory.beforeMode.toString(8).padStart(4, '0')}</p>
          )}
          {directory.afterMode !== undefined && (
            <p>After · directory · mode {directory.afterMode.toString(8).padStart(4, '0')}</p>
          )}
        </div>
      ))}
      {files.map(file => (
        <details class={styles.file} key={file.path} open={file.path === 'SKILL.md'}>
          <summary>
            <span class={styles.path}>
              <GlyphFileIcon path={file.path} />
              {escapeDisplayControls(file.path, true)} {file.status && <small>({file.status})</small>}
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
            <pre
              class={`${styles.contents} ${styles.before}`}
              aria-label={`Before ${escapeDisplayControls(file.path, true)}`}
            >
              {escapeDisplayControls(file.before)}
            </pre>
          )}
          {file.after !== undefined && (
            <pre
              class={`${styles.contents} ${styles.after}`}
              aria-label={`After ${escapeDisplayControls(file.path, true)}`}
            >
              {escapeDisplayControls(file.after)}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}
