import { Disposable, DisposableStore, toDisposable } from '#vs/base/common/lifecycle.js';
import { URI } from '#vs/base/common/uri.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ILanguageService } from '#vs/editor/common/languages/language.js';
import { ITextModelService } from '#vs/editor/common/services/resolverService.js';
import { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import { ZoneWidget } from '#vs/editor/contrib/zoneWidget/browser/zoneWidget.js';
import { EditorOption } from '#vs/editor/common/config/editorOptions.js';
import { isDiffEditor, type ICodeEditor } from '#vs/editor/browser/editorBrowser.js';
import type { GlyphAgentReviewFinding } from '#glyph/workbench/GlyphAgentReviewFinding.js';
import { mountGlyphAgentReviewComment } from './ui/mountGlyphWorkbench.js';

export interface GlyphAgentReviewFile {
  readonly uri: URI;
  readonly before: string;
  readonly after: string;
}
/** Immutable reviewed revisions with native diff navigation and inline finding comments. */
export class GlyphAgentReviewEditor extends Disposable {
  private readonly comments = this._register(new DisposableStore());
  private readonly resources = new Map<string, { readonly uri: URI; readonly source: URI; readonly text: string }>();
  private readonly comparisons = new WeakMap<GlyphAgentReviewFile, { before: URI; after: URI }>();
  private readonly issueComments = new Map<string, DisposableStore>();
  private revision = 0;
  constructor(
    @IModelService private readonly models: IModelService,
    @ILanguageService private readonly languages: ILanguageService,
    @ITextModelService resolver: ITextModelService,
    @IEditorService private readonly editors: IEditorService,
  ) {
    super();
    this._register(
      resolver.registerTextModelContentProvider('glyph-agent-review', {
        provideTextContent: async uri => {
          const existing = this.models.getModel(uri);
          if (existing) return existing;
          const resource = this.resources.get(uri.toString());
          if (!resource) return null;
          // Code OSS disposes virtual models when their final editor reference closes.
          // Keep the captured revision available when the finding is reopened.
          return this.models.createModel(
            resource.text,
            this.languages.createByFilepathOrFirstLine(resource.source),
            uri,
          );
        },
      }),
    );
    this._register(
      toDisposable(() => {
        for (const { uri } of this.resources.values()) this.models.getModel(uri)?.dispose();
        this.resources.clear();
      }),
    );
  }
  async open(
    file: GlyphAgentReviewFile,
    finding: GlyphAgentReviewFinding,
    findings: readonly GlyphAgentReviewFinding[],
    fix: (finding: GlyphAgentReviewFinding) => void,
    dismiss: (finding: GlyphAgentReviewFinding) => void,
  ): Promise<void> {
    const revision = ++this.revision;
    this.comments.clear();
    const id = generateUuid();
    const resource = (side: string, text: string) => {
      const uri = URI.from({ scheme: 'glyph-agent-review', path: `/${id}/${side}/${file.uri.path.split('/').at(-1)}` });
      this.resources.set(uri.toString(), { uri, source: file.uri, text });
      return uri;
    };
    let comparison = this.comparisons.get(file);
    if (!comparison) {
      comparison = { before: resource('before', file.before), after: resource('after', file.after) };
      this.comparisons.set(file, comparison);
    }
    const pane = await this.editors.openEditor({
      original: { resource: comparison.before },
      modified: { resource: comparison.after },
      label: `Agent Review — ${finding.path}`,
      options: { pinned: true },
    });
    if (this._store.isDisposed || revision !== this.revision || !pane) return;
    const diff = pane.getControl();
    if (!isDiffEditor(diff)) throw new Error('The native review diff editor is unavailable.');
    diff.updateOptions({ readOnly: true, originalEditable: false, renderSideBySide: true });
    const editorFor = (issue: GlyphAgentReviewFinding) =>
      (issue.side ?? (file.after ? 'modified' : 'original')) === 'original'
        ? diff.getOriginalEditor()
        : diff.getModifiedEditor();
    for (const issue of findings.filter(issue => issue.path === finding.path)) {
      const comment = this.comments.add(new DisposableStore());
      this.issueComments.set(issue.id, comment);
      comment.add(
        new GlyphReviewCommentWidget(
          editorFor(issue),
          issue,
          () => {
            fix(issue);
          },
          () => {
            dismiss(issue);
          },
        ),
      );
      comment.add(
        toDisposable(() => {
          this.issueComments.delete(issue.id);
        }),
      );
    }
    editorFor(finding).revealLineInCenter(finding.line);
  }
  dismiss(id: string): void {
    this.issueComments.get(id)?.dispose();
  }

  clear(): void {
    this.revision++;
    this.comments.clear();
    this.issueComments.clear();
  }
}

/** Native zone widgets reserve diff space while keeping interactive comments in the accessible overlay layer. */
class GlyphReviewCommentWidget extends ZoneWidget {
  constructor(
    editor: ICodeEditor,
    private readonly finding: GlyphAgentReviewFinding,
    private readonly fix: () => void,
    private readonly dismiss: () => void,
  ) {
    super(editor, { isAccessible: true, showArrow: false, showFrame: false, keepEditorSelection: true });
    this.create();
    this.show({ lineNumber: finding.line, column: 1 }, 8);
  }
  protected override _fillContainer(container: HTMLElement): void {
    this._disposables.add(mountGlyphAgentReviewComment(container, this.finding, this.fix, this.dismiss));
    const observer = new ResizeObserver(() => {
      const height = Math.max(100, Math.min(500, container.firstElementChild?.scrollHeight ?? 150));
      this._relayout(Math.ceil(height / this.editor.getOption(EditorOption.lineHeight)));
    });
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    this._disposables.add(
      toDisposable(() => {
        observer.disconnect();
      }),
    );
  }
}
