import { Button, ButtonVariant } from '#code-oss/ui/Button/Button.tsx';
import type { ComponentProps } from 'preact';
import { GlyphEditorAnnotationMarker } from './GlyphEditorAnnotationMarker.tsx';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { useEffect, useRef, useState } from 'preact/hooks';
import { expect, waitFor, within, userEvent, fn } from 'storybook/test';
import { FileCode2 } from 'lucide-preact';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { GlyphReviewCommand } from '#src/desktop/workbench/GlyphReviewCommand.js';
import { reviewShortcutLabels } from '#code-oss/storybook/fixtures/ViewFixtures.ts';
import { composerFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { editorAnnotationSource, editorAnnotationsFixture } from '#code-oss/storybook/fixtures/AnnotationFixtures.ts';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import { GlyphAnnotations, GlyphAnnotationPill } from './GlyphAnnotations.presentational.tsx';
import { useGlyphAnnotationsState } from './useGlyphAnnotationsState.ts';

const styles = {
  editor: css({ height: '100%', display: 'flex', flexDirection: 'column', background: tokens.surface.canvas }),
  tab: css({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: tokens.border.default,
  }),
  breadcrumbs: css({ padding: '8px 16px', color: tokens.text.muted, fontSize: tokens.font.size.detail }),
  viewport: css({ flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 12 }),
  lines: css({
    display: 'flex',
    minWidth: 'max-content',
    position: 'relative',
    fontFamily: tokens.font.family.code,
    fontSize: 14,
    lineHeight: '26px',
  }),
  rail: css({ width: 24, flexShrink: 0 }),
  railLine: css({ height: 26, display: 'flex', alignItems: 'center' }),
  gutter: css({
    margin: 0,
    padding: '0 20px',
    textAlign: 'right',
    color: tokens.text.muted,
    userSelect: 'none',
    borderRight: tokens.border.default,
  }),
  source: css({
    margin: 0,
    padding: '0 24px 100px',
    whiteSpace: 'pre',
    font: 'inherit',
    userSelect: 'text',
    '& code': { font: 'inherit' },
  }),

  footer: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    padding: '8px 16px',
    borderTop: tokens.border.default,
    color: tokens.text.muted,
  }),
};

/** A selectable editor stand-in using the actual annotation controller and UI. */
function EditorAnnotationsPreview({ annotations }: { readonly annotations: readonly GlyphAnnotation[] }) {
  const [composer] = useState(() => {
    const value = composerFixture();
    for (const annotation of annotations) value.saveAnnotation(structuredClone(annotation));
    return value;
  });
  const state = useGlyphAnnotationsState(composer, false);
  const editor = useRef<HTMLDivElement>(null);
  const [annotationHost, setAnnotationHost] = useState<HTMLDivElement | null>(null);
  const [annotationHeight, setAnnotationHeight] = useState(128);
  const activeLine = state.draft
    ? editorAnnotationSource.text.slice(0, state.draft.annotation.from).split('\n').length - 1
    : -1;
  useEffect(() => {
    if (!annotationHost) return;
    const observer = new ResizeObserver(() =>
      setAnnotationHeight(Math.max(128, annotationHost.getBoundingClientRect().height)),
    );
    observer.observe(annotationHost);
    return () => observer.disconnect();
  }, [annotationHost]);
  const [send] = useState(() => fn().mockName('GlyphEditorAnnotations.send').mockResolvedValue(undefined));
  useEffect(() => {
    if (!state.candidate) return;
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        state.open();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [state.candidate, state.open]);
  useEffect(() => {
    // Selection capture is installed by the annotation hook's effects before play begins.
    if (editor.current) editor.current.dataset.annotationsReady = 'true';
  }, []);
  return (
    <div ref={editor} class={styles.editor}>
      <header class={styles.tab}>
        <FileCode2 size={16} /> queue.ts
      </header>
      <div class={styles.breadcrumbs}>src › queue.ts</div>
      <div class={styles.viewport} aria-label="Editor source">
        <div class={styles.lines}>
          <div class={styles.rail} aria-label="Editor annotations">
            {editorAnnotationSource.text.split('\n').map((_, line) => (
              <div class={styles.railLine} style={{ marginTop: activeLine === line ? annotationHeight : 0 }}>
                {state.annotations
                  .filter(
                    annotation => editorAnnotationSource.text.slice(0, annotation.from).split('\n').length - 1 === line,
                  )
                  .map(annotation => (
                    <GlyphEditorAnnotationMarker
                      key={annotation.id}
                      order={annotation.order}
                      comment={annotation.comment}
                      open={fn<NonNullable<ComponentProps<typeof GlyphEditorAnnotationMarker>['open']>>(() =>
                        state.edit(annotation.id),
                      ).mockName('GlyphEditorAnnotations.open')}
                    />
                  ))}
              </div>
            ))}
          </div>
          <pre class={styles.gutter} aria-hidden="true">
            {editorAnnotationSource.text.split('\n').map((_, index) => (
              <span style={{ display: 'block', height: 26, marginTop: activeLine === index ? annotationHeight : 0 }}>
                {index + 1}
              </span>
            ))}
          </pre>
          <pre class={styles.source}>
            <code
              data-glyph-source={editorAnnotationSource.id}
              data-kind="proposal"
              data-label={editorAnnotationSource.label}
              data-revision={editorAnnotationSource.revision}
            >
              {editorAnnotationSource.text.split('\n').map((line, index, lines) => (
                <span style={{ display: 'block', height: 26, marginTop: activeLine === index ? annotationHeight : 0 }}>
                  {line}
                  {index < lines.length - 1 ? '\n' : ''}
                </span>
              ))}
            </code>
          </pre>
          <div
            ref={setAnnotationHost}
            style={{
              display: state.draft ? 'block' : 'none',
              position: 'absolute',
              left: 106,
              right: 16,
              top: Math.max(0, activeLine) * 26,
              padding: '8px 0',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>
      <footer class={styles.footer}>
        <GlyphAnnotationPill annotations={state.annotations} edit={state.edit} remove={state.remove} />
        <Button
          variant={ButtonVariant.PRIMARY}
          type="button"
          onClick={fn<NonNullable<ComponentProps<'button'>['onClick']>>(() => {
            composer.setDraft('Review these annotations.');
            void composer.submit(send);
          }).mockName('GlyphEditorAnnotations.onClick')}
        >
          Submit turn
        </Button>
        <span>TypeScript · UTF-8 · Spaces: 2</span>
      </footer>
      <GlyphAnnotations
        {...state}
        hideMarkers
        {...(annotationHost ? { editorContainer: annotationHost } : {})}
        selectionShortcut={reviewShortcutLabels[GlyphReviewCommand.ADD_TO_CHAT]}
      />
    </div>
  );
}

const meta = {
  title: 'Glyph/Editor/Annotations',
  component: EditorAnnotationsPreview,
  globals: { paneWidth: '1000' },
  args: { annotations: editorAnnotationsFixture() },
} satisfies Meta<typeof EditorAnnotationsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithComments: Story = {};
export const Selection: Story = {
  args: { annotations: [] },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('[data-annotations-ready]')).not.toBeNull());
    const source = canvasElement.querySelector('[data-glyph-source]');
    if (!source) return;
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (editorAnnotationSource.selection.from >= offset && editorAnnotationSource.selection.from < offset + length)
        range.setStart(node, editorAnnotationSource.selection.from - offset);
      if (editorAnnotationSource.selection.to > offset && editorAnnotationSource.selection.to <= offset + length) {
        range.setEnd(node, editorAnnotationSource.selection.to - offset);
        break;
      }
      offset += length;
    }
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup'));
  },
};
export const EditingComment: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Edit annotation 1' })).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Edit annotation 1' }));
  },
};
