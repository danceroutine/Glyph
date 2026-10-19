import { reviewControlsFixture } from '#code-oss/storybook/fixtures/ViewFixtures.ts';
import { editorChanges } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { useState } from 'preact/hooks';
import { FileCode2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphReviewControls } from './GlyphReviewControls.wired.tsx';
const meta = {
  title: 'Glyph/Editor/Editor review controls',
  component: WiredGlyphReviewControls,
  args: reviewControlsFixture(),
} satisfies Meta<typeof WiredGlyphReviewControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FileToolbar: Story = {};
export const Hunk: Story = {
  render: ({ label, disabled, keepDisabled, previous, next, keep, undo }) => (
    <WiredGlyphReviewControls
      label={label}
      itemId="example-hunk"
      shortcutModifier="⌘"
      rejectWithComment={async () => {}}
      disabled={disabled}
      keepDisabled={keepDisabled}
      previous={previous}
      next={next}
      keep={keep}
      undo={undo}
    />
  ),
};

const editorStyles = {
  editor: css({
    height: '100%',
    background: tokens.surface.canvas,
    color: tokens.text.primary,
    fontSize: 13,
    overflow: 'auto',
  }),
  tab: css({
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    padding: '10px 16px',
    borderBottom: tokens.border.default,
    color: tokens.text.muted,
  }),
  toolbar: css({ padding: '8px 16px', display: 'flex', justifyContent: 'flex-end' }),
  code: css({ fontFamily: tokens.font.family.code, lineHeight: '24px', padding: '16px 0 40px' }),
  line: css({
    display: 'flex',
    whiteSpace: 'pre',
    paddingRight: 16,
    '& > span': {
      width: 48,
      paddingRight: 12,
      textAlign: 'right',
      color: tokens.text.muted,
      userSelect: 'none',
      flexShrink: 0,
    },
  }),
  removed: css({ background: 'rgba(239,68,68,.14)', color: '#e7a8a8' }),
  added: css({ background: 'rgba(46,160,67,.18)', color: '#b5d9a8' }),
  hunk: css({ margin: '24px 0 30px', borderBlock: tokens.border.default }),
  controls: css({
    display: 'flex',
    justifyContent: 'flex-end',
    padding: '4px 12px',
    fontFamily: tokens.font.family.body,
  }),
  status: css({ padding: '8px 16px', color: tokens.text.muted, fontFamily: tokens.font.family.body }),
};
const changes = editorChanges;
function EditorPreview() {
  const [active, setActive] = useState(0);
  const [decisions, setDecisions] = useState<Record<number, 'keep' | 'undo'>>({});
  const [notice, setNotice] = useState('');
  const decide = async (index: number, decision: 'keep' | 'undo', comment?: string) => {
    setDecisions(value => ({ ...value, [index]: decision }));
    setNotice(
      comment
        ? `Change ${index + 1} rejected: ${comment}`
        : `Change ${index + 1} ${decision === 'keep' ? 'kept' : 'undone'}.`,
    );
  };
  const line = (number: number, text: string, className = '') => (
    <div class={`${editorStyles.line} ${className}`}>
      <span>{number}</span>
      {text}
    </div>
  );
  return (
    <div class={editorStyles.editor}>
      <header class={editorStyles.tab}>
        <FileCode2 size={16} /> queue.ts <span>· Modified</span>
      </header>
      <div class={editorStyles.toolbar}>
        <WiredGlyphReviewControls
          label={`${active + 1} of 2`}
          fileLabel="1 of 1 Files"
          disabled={false}
          keepDisabled={false}
          previous={() => setActive(0)}
          next={() => setActive(1)}
          keepFile={async () => {
            setDecisions({ 0: 'keep', 1: 'keep' });
            setNotice('All changes kept.');
          }}
          undoFile={async () => {
            setDecisions({ 0: 'undo', 1: 'undo' });
            setNotice('All changes undone.');
          }}
          keep={async () => {}}
          undo={async () => {}}
        />
      </div>
      <div class={editorStyles.code}>
        {line(1, 'const pendingMessages: string[] = [];')}
        {line(2, '')}
        {line(3, 'export function enqueue(message: string) {')}
        {changes.map((change, index) => (
          <div key={index} class={editorStyles.hunk} style={{ outline: active === index ? '1px solid #555' : 'none' }}>
            {!decisions[index] && (
              <div class={editorStyles.controls}>
                <WiredGlyphReviewControls
                  itemId={`hunk-${index}`}
                  label={`${index + 1} of 2`}
                  shortcutModifier="⌘"
                  disabled={false}
                  keepDisabled={false}
                  previous={() => setActive(Math.max(0, index - 1))}
                  next={() => setActive(Math.min(1, index + 1))}
                  keep={() => decide(index, 'keep')}
                  undo={() => decide(index, 'undo')}
                  rejectWithComment={comment => decide(index, 'undo', comment)}
                />
              </div>
            )}
            {decisions[index] !== 'keep' &&
              line(index ? 8 : 4, `− ${change.before}`, decisions[index] ? '' : editorStyles.removed)}
            {decisions[index] !== 'undo' &&
              line(index ? 8 : 4, `+ ${change.after}`, decisions[index] ? '' : editorStyles.added)}
            {line(index ? 9 : 5, '}')}
            {!index && (
              <>
                {line(6, '')}
                {line(7, 'export function nextMessage() {')}
              </>
            )}
          </div>
        ))}
      </div>
      {notice && (
        <p class={editorStyles.status} role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
export const InEditor: Story = { globals: { paneWidth: '1000' }, render: () => <EditorPreview /> };
