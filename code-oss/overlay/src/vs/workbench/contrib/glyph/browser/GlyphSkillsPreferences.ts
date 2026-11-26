import * as DOM from '#vs/base/browser/dom.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { URI } from '#vs/base/common/uri.js';
import type { IPreferencesEditorPane } from '#vs/workbench/contrib/preferences/browser/preferencesEditorRegistry.js';
import { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { mountGlyphSkills } from './ui/mountGlyphWorkbench.js';

/** Native Settings integration; Preact owns presentation and native editors own skill editing. */
export class GlyphSkillsPreferences extends Disposable implements IPreferencesEditorPane {
  private readonly element = DOM.$('.glyph-skills-settings');
  private readonly view = this._register(
    mountGlyphSkills(this.element, [], '', skill => {
      void this.editors.openEditor({ resource: URI.parse(skill.uri), options: { pinned: true } });
    }),
  );
  private query = '';
  constructor(
    @GlyphWorkbenchService private readonly glyph: GlyphWorkbenchService,
    @IEditorService private readonly editors: IEditorService,
  ) {
    super();
    this._register(
      this.glyph.onDidChangeState(() => {
        this.update();
      }),
    );
    this.update();
    void this.glyph.refreshSkills();
  }
  getDomNode(): HTMLElement {
    return this.element;
  }
  layout(dimension: DOM.Dimension): void {
    this.element.style.height = `${dimension.height}px`;
  }
  search(text: string): void {
    this.query = text;
    this.update();
    void this.glyph.refreshSkills();
  }
  private update(): void {
    this.view.update(this.glyph.state.skills ?? [], this.query);
  }
}
