import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { URI } from '#vs/base/common/uri.js';
import { EditorType } from '#vs/editor/common/editorCommon.js';
import { EditorOption } from '#vs/editor/common/config/editorOptions.js';
import type { GlyphAgentReviewFinding } from '#glyph/workbench/GlyphAgentReviewFinding.js';
import {
  GlyphAgentReviewEditor,
  type GlyphAgentReviewFile,
} from '#vs/workbench/contrib/glyph/browser/GlyphAgentReviewEditor.js';
import { ZoneWidgetStub } from './support/ZoneWidgetStub.ts';

const mounts = vi.hoisted(() => ({ mountGlyphAgentReviewComment: vi.fn() }));
vi.mock('#code-oss/ui/mountGlyphWorkbench.tsx', () => mounts);
vi.mock('#vs/editor/contrib/zoneWidget/browser/zoneWidget.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  ZoneWidget: (await import('./support/ZoneWidgetStub.ts')).ZoneWidgetStub,
}));

const findingOf = (overrides: Partial<GlyphAgentReviewFinding> = {}): GlyphAgentReviewFinding => ({
  id: 'finding-1',
  path: 'src/a.ts',
  line: 3,
  title: 'Bug',
  body: 'Explain',
  ...overrides,
});

const fileOf = (overrides: Partial<GlyphAgentReviewFile> = {}): GlyphAgentReviewFile => ({
  uri: URI.file('/repo/src/a.ts'),
  before: 'old',
  after: 'new',
  ...overrides,
});

const codeEditorOf = (name: string) => ({
  name,
  revealLineInCenter: vi.fn(),
  getOption: vi.fn((option: EditorOption) => (option === EditorOption.lineHeight ? 20 : undefined)),
});

const diffOf = () => {
  const original = codeEditorOf('original');
  const modified = codeEditorOf('modified');
  return {
    original,
    modified,
    diff: {
      getEditorType: () => EditorType.IDiffEditor,
      updateOptions: vi.fn(),
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
    },
  };
};

const reviewEditorOf = () => {
  const models = new Map<string, { uri: URI; text: string; language: unknown; dispose: ReturnType<typeof vi.fn> }>();
  let provider: { provideTextContent(uri: URI): Promise<unknown> } | undefined;
  const services = {
    models: {
      getModel: vi.fn((uri: URI) => models.get(uri.toString()) ?? null),
      createModel: vi.fn((text: string, language: unknown, uri: URI) => {
        const model = { uri, text, language, dispose: vi.fn(() => models.delete(uri.toString())) };
        models.set(uri.toString(), model);
        return model;
      }),
    },
    languages: { createByFilepathOrFirstLine: vi.fn((uri: URI) => `language:${uri.path}`) },
    resolver: {
      registerTextModelContentProvider: vi.fn((_scheme: string, value: typeof provider) => {
        provider = value;
        return { dispose: vi.fn() };
      }),
    },
    editors: { openEditor: vi.fn(async (_input: unknown): Promise<unknown> => undefined) },
  };
  const editor = new GlyphAgentReviewEditor(
    services.models as never,
    services.languages as never,
    services.resolver as never,
    services.editors as never,
  );
  onTestFinished(() => {
    editor.dispose();
    ZoneWidgetStub.instances.length = 0;
    mounts.mountGlyphAgentReviewComment.mockReset();
  });
  const opened = (diff: unknown) => {
    services.editors.openEditor.mockResolvedValueOnce({ getControl: () => diff });
  };
  return { editor, services, models, opened, provide: (uri: URI) => provider!.provideTextContent(uri) };
};

const commentOf = () => {
  const comment = { dispose: vi.fn() };
  mounts.mountGlyphAgentReviewComment.mockReturnValueOnce(comment);
  return comment;
};

describe(GlyphAgentReviewEditor, () => {
  it('serves the captured revisions as read-only documents', async () => {
    const { editor, services, opened, provide } = reviewEditorOf();
    opened(diffOf().diff);
    await editor.open(fileOf(), findingOf(), [], vi.fn(), vi.fn());
    const { original, modified } = services.editors.openEditor.mock.calls[0][0] as unknown as {
      original: { resource: URI };
      modified: { resource: URI };
    };

    const before = await provide(original.resource);
    const after = await provide(modified.resource);

    expect(services.resolver.registerTextModelContentProvider).toHaveBeenCalledWith(
      'glyph-agent-review',
      expect.any(Object),
    );
    expect(original.resource.scheme).toBe('glyph-agent-review');
    expect(original.resource.path).toMatch(/^\/[^/]+\/before\/a\.ts$/);
    expect(modified.resource.path).toMatch(/^\/[^/]+\/after\/a\.ts$/);
    expect(before).toEqual(expect.objectContaining({ text: 'old', language: 'language:/repo/src/a.ts' }));
    expect(after).toEqual(expect.objectContaining({ text: 'new' }));
    expect(await provide(original.resource)).toBe(before);
    expect(await provide(URI.parse('glyph-agent-review:/unknown/before/a.ts'))).toBeNull();
    expect(services.models.createModel).toHaveBeenCalledTimes(2);
  });

  it('releases its documents when disposed', async () => {
    const { editor, services, models, opened, provide } = reviewEditorOf();
    opened(diffOf().diff);
    await editor.open(fileOf(), findingOf(), [], vi.fn(), vi.fn());
    const { original } = services.editors.openEditor.mock.calls[0][0] as unknown as { original: { resource: URI } };
    const model = (await provide(original.resource)) as { dispose: ReturnType<typeof vi.fn> };

    editor.dispose();

    expect(model.dispose).toHaveBeenCalled();
    expect(models.size).toBe(0);
  });

  describe(GlyphAgentReviewEditor.prototype.open, () => {
    it('opens a read-only side-by-side diff and comments on each finding in the file', async () => {
      const { editor, services, opened } = reviewEditorOf();
      const { diff, original, modified } = diffOf();
      opened(diff);
      const fix = vi.fn();
      const dismiss = vi.fn();
      const findings = [
        findingOf({ id: 'finding-1', line: 3 }),
        findingOf({ id: 'finding-2', line: 7, side: 'original' }),
        findingOf({ id: 'finding-3', path: 'src/b.ts' }),
      ];
      commentOf();
      commentOf();

      await editor.open(fileOf(), findings[0], findings, fix, dismiss);

      expect(services.editors.openEditor).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'Agent Review — src/a.ts', options: { pinned: true } }),
      );
      expect(diff.updateOptions).toHaveBeenCalledWith({
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
      });
      expect(ZoneWidgetStub.instances.map(widget => [widget.editor, widget.shown])).toEqual([
        [modified, { position: { lineNumber: 3, column: 1 }, heightInLines: 8 }],
        [original, { position: { lineNumber: 7, column: 1 }, heightInLines: 8 }],
      ]);
      expect(ZoneWidgetStub.instances[0].options).toEqual({
        isAccessible: true,
        showArrow: false,
        showFrame: false,
        keepEditorSelection: true,
      });
      expect(modified.revealLineInCenter).toHaveBeenCalledWith(3);
      expect(original.revealLineInCenter).not.toHaveBeenCalled();
      const [container, finding, fixed, dismissed] = mounts.mountGlyphAgentReviewComment.mock.calls[1];
      expect(container).toBe(ZoneWidgetStub.instances[1].container);
      expect(finding).toBe(findings[1]);
      fixed();
      dismissed();
      expect(fix).toHaveBeenCalledWith(findings[1]);
      expect(dismiss).toHaveBeenCalledWith(findings[1]);
    });

    it('comments on the original side of deleted files', async () => {
      const { editor, opened } = reviewEditorOf();
      const { diff, original } = diffOf();
      opened(diff);

      await editor.open(fileOf({ after: '' }), findingOf(), [findingOf()], vi.fn(), vi.fn());

      expect(ZoneWidgetStub.instances[0].editor).toBe(original);
      expect(original.revealLineInCenter).toHaveBeenCalledWith(3);
    });

    it('reuses the captured documents when a file is reopened', async () => {
      const { editor, services, opened } = reviewEditorOf();
      const file = fileOf();
      opened(diffOf().diff);
      opened(diffOf().diff);

      await editor.open(file, findingOf(), [], vi.fn(), vi.fn());
      await editor.open(file, findingOf(), [], vi.fn(), vi.fn());

      const [first, second] = services.editors.openEditor.mock.calls.map(call => call[0]);
      expect(second).toEqual(first);
    });

    it('replaces the comments of the previously opened finding', async () => {
      const { editor, opened } = reviewEditorOf();
      opened(diffOf().diff);
      opened(diffOf().diff);
      const first = commentOf();

      await editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());
      await editor.open(fileOf(), findingOf(), [], vi.fn(), vi.fn());

      expect(first.dispose).toHaveBeenCalled();
      expect(ZoneWidgetStub.instances[0].disposed).toBe(true);
    });

    it('stops when no diff opened, a newer finding opened, or the editor was disposed', async () => {
      const unopened = reviewEditorOf();
      const superseded = reviewEditorOf();
      const disposed = reviewEditorOf();
      const supersededDiff = diffOf();
      const disposedDiff = diffOf();
      superseded.opened(supersededDiff.diff);
      disposed.opened(disposedDiff.diff);

      await unopened.editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());
      const stale = superseded.editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());
      superseded.editor.clear();
      await stale;
      const closing = disposed.editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());
      disposed.editor.dispose();
      await closing;

      expect(supersededDiff.diff.updateOptions).not.toHaveBeenCalled();
      expect(disposedDiff.diff.updateOptions).not.toHaveBeenCalled();
      expect(ZoneWidgetStub.instances).toEqual([]);
    });

    it('requires the native diff editor', async () => {
      const { editor, opened } = reviewEditorOf();
      opened({ getEditorType: () => EditorType.ICodeEditor });

      await expect(editor.open(fileOf(), findingOf(), [], vi.fn(), vi.fn())).rejects.toThrow(
        'The native review diff editor is unavailable.',
      );
    });

    it('sizes each comment to its content', async () => {
      const { editor, opened } = reviewEditorOf();
      opened(diffOf().diff);
      mounts.mountGlyphAgentReviewComment.mockImplementationOnce((container: HTMLElement) => {
        const body = document.createElement('div');
        body.style.height = '300px';
        container.append(body);
        return { dispose: () => body.remove() };
      });

      await editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());
      const [widget] = ZoneWidgetStub.instances;
      await vi.waitFor(() => expect(widget.relayouts).toEqual([15]));
      const body = widget.container.firstElementChild as HTMLElement;
      body.style.height = '900px';
      await vi.waitFor(() => expect(widget.relayouts).toEqual([15, 25]));
      body.style.height = '10px';
      await vi.waitFor(() => expect(widget.relayouts).toEqual([15, 25, 5]));
      body.remove();
      await vi.waitFor(() => expect(widget.relayouts).toEqual([15, 25, 5, 8]));
    });

    it('leaves empty comments at their initial size', async () => {
      const { editor, opened } = reviewEditorOf();
      opened(diffOf().diff);

      await editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());

      expect(ZoneWidgetStub.instances[0].relayouts).toEqual([]);
    });
  });

  describe(GlyphAgentReviewEditor.prototype.dismiss, () => {
    it('removes the comment of a dismissed finding', async () => {
      const { editor, opened } = reviewEditorOf();
      opened(diffOf().diff);
      const first = commentOf();
      const second = commentOf();
      await editor.open(
        fileOf(),
        findingOf(),
        [findingOf({ id: 'finding-1' }), findingOf({ id: 'finding-2' })],
        vi.fn(),
        vi.fn(),
      );

      editor.dismiss('finding-1');
      editor.dismiss('finding-1');
      editor.dismiss('unknown');

      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(second.dispose).not.toHaveBeenCalled();
    });
  });

  describe(GlyphAgentReviewEditor.prototype.clear, () => {
    it('removes every comment', async () => {
      const { editor, opened } = reviewEditorOf();
      opened(diffOf().diff);
      const comment = commentOf();
      await editor.open(fileOf(), findingOf(), [findingOf()], vi.fn(), vi.fn());

      editor.clear();
      editor.dismiss('finding-1');

      expect(comment.dispose).toHaveBeenCalledTimes(1);
    });
  });
});
