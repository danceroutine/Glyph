import * as DOM from '#vs/base/browser/dom.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { URI } from '#vs/base/common/uri.js';
import type { IPreferencesEditorPane } from '#vs/workbench/contrib/preferences/browser/preferencesEditorRegistry.js';
import { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import { IWorkspaceContextService } from '#vs/platform/workspace/common/workspace.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { mountGlyphAgentInstructions } from './ui/mountGlyphWorkbench.js';

/** Native Settings page backed by the same host catalog that supplies model context. */
export class GlyphAgentInstructionsPreferences extends Disposable implements IPreferencesEditorPane {
  private readonly element = DOM.$('.glyph-agent-instructions-settings');
  private readonly view = this._register(
    mountGlyphAgentInstructions(this.element, [], '', source => {
      const resource = this.resource(source.path);
      if (resource) void this.editors.openEditor({ resource });
    }),
  );
  private query = '';

  constructor(
    @GlyphWorkbenchService private readonly glyph: GlyphWorkbenchService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IEditorService private readonly editors: IEditorService,
  ) {
    super();
    this._register(
      this.glyph.onDidChangeState(() => {
        this.update();
      }),
    );
    this.update();
  }

  getDomNode(): HTMLElement {
    return this.element;
  }

  layout(dimension: DOM.Dimension): void {
    this.element.style.height = `${dimension.height}px`;
  }

  search(text: string): void {
    this.query = text.trim().toLocaleLowerCase();
    this.update();
  }

  private update(): void {
    this.view.update(this.glyph.state.instructionSources ?? [], this.query);
  }

  private resource(path: string): URI | undefined {
    const folders = this.workspace.getWorkspace().folders;
    if (folders.length === 0) return undefined;
    if (folders.length === 1) return URI.joinPath(folders[0].uri, path);
    const [rootName, ...relative] = path.split('/');
    const folder = folders.find(candidate => candidate.name === rootName);
    return folder ? URI.joinPath(folder.uri, ...relative) : undefined;
  }
}
