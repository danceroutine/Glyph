import { Dimension } from '#vs/base/browser/dom.js';
import { URI } from '#vs/base/common/uri.js';
import { CancellationToken } from '#vs/base/common/cancellation.js';
import { IStorageService } from '#vs/platform/storage/common/storage.js';
import { ITelemetryService } from '#vs/platform/telemetry/common/telemetry.js';
import { IThemeService } from '#vs/platform/theme/common/themeService.js';
import { EditorPane } from '#vs/workbench/browser/parts/editor/editorPane.js';
import { EditorInput } from '#vs/workbench/common/editor/editorInput.js';
import type { IEditorOptions } from '#vs/platform/editor/common/editor.js';
import type { IEditorOpenContext, IUntypedEditorInput } from '#vs/workbench/common/editor.js';
import type { IEditorGroup } from '#vs/workbench/services/editor/common/editorGroupsService.js';
import type { GlyphPlanViewActions, GlyphPlanViewState, GlyphPlanMount } from '#glyph/workbench/GlyphPlanView.js';
import { mountGlyphPlan } from './ui/mountGlyphWorkbench.js';

export class GlyphPlanInput extends EditorInput {
  static readonly ID = 'workbench.input.glyphPlan';
  readonly resource: URI;
  constructor(
    readonly read: () => GlyphPlanViewState,
    readonly actions: GlyphPlanViewActions,
    readonly subscribe: (listener: () => void) => { dispose(): void },
  ) {
    super();
    this.resource = URI.from({ scheme: 'glyph-plan', path: `/${read().plan.id}` });
  }
  override get typeId(): string {
    return GlyphPlanInput.ID;
  }
  override matches(other: EditorInput | IUntypedEditorInput): boolean {
    return (
      super.matches(other) ||
      (other instanceof GlyphPlanInput && other.resource.toString() === this.resource.toString())
    );
  }
  override getName(): string {
    return this.read().plan.title;
  }
}
/** A real workbench document; no extension host or webview. */
export class GlyphPlanEditor extends EditorPane {
  static readonly ID = 'workbench.editor.glyphPlan';
  private container: HTMLElement | undefined;
  private view: ReturnType<GlyphPlanMount> | undefined;
  private subscription: { dispose(): void } | undefined;
  constructor(
    group: IEditorGroup,
    @ITelemetryService telemetry: ITelemetryService,
    @IThemeService theme: IThemeService,
    @IStorageService storage: IStorageService,
  ) {
    super(GlyphPlanEditor.ID, group, telemetry, theme, storage);
  }
  override async setInput(
    input: EditorInput,
    options: IEditorOptions | undefined,
    context: IEditorOpenContext,
    token: CancellationToken,
  ): Promise<void> {
    this.subscription?.dispose();
    this.view?.dispose();
    await super.setInput(input, options, context, token);
    if (token.isCancellationRequested || !(input instanceof GlyphPlanInput) || !this.container) return;
    this.view = mountGlyphPlan(this.container, input.read(), input.actions);
    this.subscription = input.subscribe(() => this.view?.update(input.read()));
  }
  override layout(dimension: Dimension): void {
    if (this.container) {
      this.container.style.width = `${dimension.width}px`;
      this.container.style.height = `${dimension.height}px`;
    }
  }
  override focus(): void {
    this.container?.focus();
  }
  override clearInput(): void {
    this.subscription?.dispose();
    this.view?.dispose();
    this.view = undefined;
    super.clearInput();
  }
  override dispose(): void {
    this.subscription?.dispose();
    this.view?.dispose();
    super.dispose();
  }
  protected override createEditor(parent: HTMLElement): void {
    this.container = document.createElement('div');
    this.container.tabIndex = 0;
    parent.append(this.container);
  }
}
