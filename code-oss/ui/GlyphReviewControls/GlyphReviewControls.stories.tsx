import type { ComponentProps } from 'preact';
import { fn } from 'storybook/test';
import { reviewControlsFixture, reviewShortcutLabels } from '#code-oss/storybook/fixtures/ViewFixtures.ts';
import { editorChanges } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { useState } from 'preact/hooks';
import { FileCode2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphReviewControls } from './GlyphReviewControls.wired.tsx';
const meta = {
  title: 'Glyph/Editor/Editor review controls',
  component: WiredGlyphReviewControls,
  globals: { paneWidth: '1000' },
  args: reviewControlsFixture(),
} satisfies Meta<typeof WiredGlyphReviewControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FileToolbar: Story = {};
export const FileComplete: Story = { args: { fileComplete: true, disabled: true, keepDisabled: true } };
export const InlineDiffControls: Story = {
  render: ({ label, disabled, keepDisabled, previous, next, keep, undo }) => (
    <WiredGlyphReviewControls
      label={label}
      itemId="example-hunk"
      shortcuts={reviewShortcutLabels}
      rejectWithComment={fn<() => Promise<void>>()
        .mockName('GlyphReviewControls.rejectWithComment')
        .mockResolvedValue(undefined)}
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
  const [activeFile, setActiveFile] = useState(0);
  const [allDecisions, setDecisions] = useState<Record<string, 'keep' | 'undo'>>({});
  const decisions = changes.map((_, index) => allDecisions[`${activeFile}:${index}`]);
  const complete = decisions.every(Boolean);
  const allComplete = [0, 1].every(file => changes.every((_, index) => allDecisions[`${file}:${index}`]));
  const decideFile = async (decision: 'keep' | 'undo') => {
    setDecisions(value => ({
      ...value,
      ...Object.fromEntries(changes.map((_, index) => [`${activeFile}:${index}`, decision])),
    }));
  };
  const moveFile = async (amount: number) => {
    setActiveFile(value => (value + amount + 2) % 2);
    setActive(0);
  };
  const [notice, setNotice] = useState('');
  const decide = async (index: number, decision: 'keep' | 'undo', comment?: string) => {
    setDecisions(value => ({ ...value, [`${activeFile}:${index}`]: decision }));
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
        <FileCode2 size={16} /> {activeFile ? 'worker.ts' : 'queue.ts'}{' '}
        <span>· {complete ? 'Reviewed' : 'Modified'}</span>
      </header>
      <div class={editorStyles.toolbar}>
        <WiredGlyphReviewControls
          label={`${active + 1} of 2`}
          fileLabel={`${activeFile + 1} of 2 Files`}
          fileComplete={complete}
          shortcuts={reviewShortcutLabels}
          disabled={complete}
          keepDisabled={complete}
          keepAllDisabled={allComplete}
          navigationDisabled={allComplete}
          previousFile={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['previousFile']>>(() =>
            moveFile(-1),
          ).mockName('GlyphReviewControls.previousFile')}
          nextFile={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['nextFile']>>(() =>
            moveFile(1),
          ).mockName('GlyphReviewControls.nextFile')}
          previous={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['previous']>>(() =>
            setActive(0),
          ).mockName('GlyphReviewControls.previous')}
          next={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['next']>>(() => setActive(1)).mockName(
            'GlyphReviewControls.next',
          )}
          keepFile={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['keepFile']>>(() =>
            decideFile('keep'),
          ).mockName('GlyphReviewControls.keepFile')}
          undoFile={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['undoFile']>>(() =>
            decideFile('undo'),
          ).mockName('GlyphReviewControls.undoFile')}
          keepAll={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['keepAll']>>(async () => {
            setDecisions(
              Object.fromEntries([0, 1].flatMap(file => changes.map((_, index) => [`${file}:${index}`, 'keep']))),
            );
            setNotice('All changes kept.');
          }).mockName('GlyphReviewControls.keepAll')}
          keep={fn<() => Promise<void>>().mockName('GlyphReviewControls.keep').mockResolvedValue(undefined)}
          undo={fn<() => Promise<void>>().mockName('GlyphReviewControls.undo').mockResolvedValue(undefined)}
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
                  shortcuts={reviewShortcutLabels}
                  disabled={false}
                  keepDisabled={false}
                  previous={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['previous']>>(() =>
                    setActive(Math.max(0, index - 1)),
                  ).mockName('GlyphReviewControls.previous')}
                  next={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['next']>>(() =>
                    setActive(Math.min(1, index + 1)),
                  ).mockName('GlyphReviewControls.next')}
                  keep={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['keep']>>(() =>
                    decide(index, 'keep'),
                  ).mockName('GlyphReviewControls.keep')}
                  undo={fn<NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['undo']>>(() =>
                    decide(index, 'undo'),
                  ).mockName('GlyphReviewControls.undo')}
                  rejectWithComment={fn<
                    NonNullable<ComponentProps<typeof WiredGlyphReviewControls>['rejectWithComment']>
                  >(comment => decide(index, 'undo', comment)).mockName('GlyphReviewControls.rejectWithComment')}
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
export const InEditor: Story = { render: () => <EditorPreview /> };
