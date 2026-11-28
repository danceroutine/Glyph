import * as DOM from '#vs/base/browser/dom.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import type { IPreferencesEditorPane } from '#vs/workbench/contrib/preferences/browser/preferencesEditorRegistry.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { mountGlyphAgentInstructions } from './ui/mountGlyphWorkbench.js';

/** Native Settings page backed by the same host catalog that supplies model context. */
export class GlyphAgentInstructionsPreferences extends Disposable implements IPreferencesEditorPane {
  private readonly element = DOM.$('.glyph-agent-instructions-settings');
  private readonly view = this._register(
    mountGlyphAgentInstructions(
      this.element,
      [],
      '',
      source => this.glyph.openLink(`glyph-instruction:${encodeURIComponent(source.id)}`),
      {
        createUserRule: (name, activation, condition) => this.glyph.createUserRule(name, activation, condition),
        setUserRuleEnabled: (source, enabled) => this.glyph.setUserRuleEnabled(source, enabled),
        deleteUserRule: source => this.glyph.deleteUserRule(source),
      },
    ),
  );
  private query = '';
  private refreshError = '';
  private refreshing = false;

  constructor(@GlyphWorkbenchService private readonly glyph: GlyphWorkbenchService) {
    super();
    this._register(
      this.glyph.onDidChangeState(() => {
        this.update();
      }),
    );
    this.update();
    void this.refresh();
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
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.glyph.refreshInstructionSources?.();
      this.refreshError = '';
    } catch (error) {
      this.refreshError = error instanceof Error ? error.message : 'Agent Instructions could not be refreshed.';
    } finally {
      this.refreshing = false;
      this.update();
    }
  }

  private update(): void {
    this.view.update(
      this.glyph.state.instructionSources ?? [],
      this.query,
      this.glyph.state.readOnly || this.glyph.state.instructionSources === undefined,
      this.refreshError,
    );
  }
}
