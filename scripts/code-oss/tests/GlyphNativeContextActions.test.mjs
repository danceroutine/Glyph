import { build } from 'esbuild';
import { resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
import { importBundle } from '#scripts/code-oss/tests/support/bundle.mjs';

/**
 * @typedef {{
 *   useGlyphContext: typeof import('#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js').useGlyphContext,
 *   GlyphComposerState: typeof import('#glyph/workbench/GlyphComposerState.js').GlyphComposerState,
 * }} ContextActionModule
 */

/** @type {ContextActionModule['GlyphComposerState']} */
let GlyphComposerState;
/** @type {ContextActionModule['useGlyphContext']} */
let useGlyphContext;
beforeAll(async () => {
  const built = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        export { useGlyphContext } from './code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.ts';
        export { GlyphComposerState } from './src/desktop/workbench/GlyphComposerState.ts';
      `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'context-action-services',
        setup(builder) {
          builder.onResolve({ filter: /GlyphViewPane\.js$|mountGlyphWorkbench\.js$/ }, args => ({
            path: args.path,
            namespace: 'view',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'view' }, () => ({
            contents: 'export const GlyphViewPane = { ID: "glyph" }; export function mountGlyphContextButton() {}',
          }));
          builder.onResolve({ filter: /^#vs\// }, args =>
            args.path.startsWith('#vs/base/')
              ? { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) }
              : { path: args.path, namespace: 'service' },
          );
          builder.onLoad({ filter: /.*/, namespace: 'service' }, () => ({
            contents: `const service = () => {}; export { service as IMarkerDecorationsService,
            service as INotificationService, service as IKeybindingService, service as IViewsService,
            service as ITerminalService, service as GlyphWorkbenchService, service as Range,
            service as MarkerHover, service as HoverAnchorType, service as RenderedHoverParts };`,
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  /** @type {ContextActionModule} */
  const api = await importBundle(built.outputFiles[0].text, ['useGlyphContext', 'GlyphComposerState']);
  ({ useGlyphContext, GlyphComposerState } = api);
});

it.each(['chat', 'draft'])(
  'retains the action without sending when the %s changes while opening the pane',
  async change => {
    const source = new GlyphComposerState();
    const other = new GlyphComposerState();
    other.setDraft('Unrelated beta draft');
    const glyph = { composer: source, send: vi.fn(async () => {}) };
    /** @type {PromiseWithResolvers<void>} */
    const gate = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const opening = Promise.withResolvers();
    const views = {
      openView: async () => {
        opening.resolve();
        await gate.promise;
      },
    };
    const attachment = { path: 'alpha.ts', text: 'Captured alpha source', contentRevision: '1' };
    const action = useGlyphContext(glyph, views, async () => [attachment], 'Fix the attached diagnostic.');
    await opening.promise;
    const actionDocument = source.snapshot.document;
    if (change === 'chat') glyph.composer = other;
    else source.setDraft('A newer draft');
    gate.resolve();
    await expect(action).rejects.toThrow('draft changed');
    expect(glyph.send).not.toHaveBeenCalled();
    expect(other.snapshot.draft).toBe('Unrelated beta draft');
    if (change === 'chat') expect(source.snapshot.document).toBe(actionDocument);
    else expect(source.snapshot.draft).toBe('A newer draft');
  },
);

it('submits the captured action when its chat and draft remain selected', async () => {
  const glyph = { composer: new GlyphComposerState(), send: vi.fn(async () => {}) };
  const attachment = { path: 'alpha.ts', text: 'Captured alpha source', contentRevision: '1' };
  await useGlyphContext(glyph, { openView: async () => {} }, async () => [attachment], 'Fix the attached diagnostic.');
  expect(glyph.send).toHaveBeenCalledWith(
    expect.stringContaining('Fix the attached diagnostic.'),
    [attachment],
    expect.objectContaining({ attachmentSpans: [{ from: 28, to: 37 }] }),
  );
  expect(glyph.composer.snapshot.draft).toBe('');
});
