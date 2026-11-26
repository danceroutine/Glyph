import * as DOM from '#vs/base/browser/dom.js';
import { toErrorMessage } from '#vs/base/common/errorMessage.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import type { IPreferencesEditorPane } from '#vs/workbench/contrib/preferences/browser/preferencesEditorRegistry.js';
import { INotificationService } from '#vs/platform/notification/common/notification.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { mountGlyphSkills } from './ui/mountGlyphWorkbench.js';

/** Native Settings integration; Preact owns presentation and native editors own skill editing. */
export class GlyphSkillsPreferences extends Disposable implements IPreferencesEditorPane {
  private readonly element = DOM.$('.glyph-skills-settings');
  private readonly view = this._register(
    mountGlyphSkills(this.element, [], '', skill => {
      void this.glyph.openLink(`glyph-skill:${encodeURIComponent(skill.id)}`).catch((error: unknown) => {
        this.notifications.error(toErrorMessage(error));
      });
    }),
  );
  private query = '';
  constructor(
    @GlyphWorkbenchService private readonly glyph: GlyphWorkbenchService,
    @INotificationService private readonly notifications: INotificationService,
  ) {
    super();
    this._register(
      this.glyph.onDidChangeState(() => {
        this.update();
      }),
    );
    this.update();
    void this.glyph.refreshSkills().catch(() => undefined);
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
    void this.glyph.refreshSkills().catch(() => undefined);
  }
  private update(): void {
    this.view.update(this.glyph.state.skills ?? [], this.query);
  }
}
