import { MutableDisposable } from '#vs/base/common/lifecycle.js';
import { IConfigurationService } from '#vs/platform/configuration/common/configuration.js';
import { IContextKeyService } from '#vs/platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '#vs/platform/contextview/browser/contextView.js';
import { IHoverService } from '#vs/platform/hover/browser/hover.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '#vs/platform/keybinding/common/keybinding.js';
import { IOpenerService } from '#vs/platform/opener/common/opener.js';
import { IThemeService } from '#vs/platform/theme/common/themeService.js';
import { ViewPane } from '#vs/workbench/browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '#vs/workbench/browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '#vs/workbench/common/views.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import type { GlyphWorkbenchView } from '#glyph/workbench/GlyphWorkbenchView.js';
import { mountGlyphWorkbench } from './ui/mountGlyphWorkbench.js';
import './ui/mountGlyphWorkbench.css';

/**
 * Hosts Glyph in the native auxiliary bar, sharing the workbench's focus,
 * visibility, and disposal lifecycle.
 */
export class GlyphViewPane extends ViewPane {
  static readonly ID = 'workbench.view.glyph';
  private readonly view = this._register(new MutableDisposable<GlyphWorkbenchView>());

  constructor(
    options: IViewletViewOptions,
    @IKeybindingService keybindingService: IKeybindingService,
    @IContextMenuService contextMenuService: IContextMenuService,
    @IConfigurationService configurationService: IConfigurationService,
    @IContextKeyService contextKeyService: IContextKeyService,
    @IViewDescriptorService viewDescriptorService: IViewDescriptorService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IOpenerService openerService: IOpenerService,
    @IThemeService themeService: IThemeService,
    @IHoverService hoverService: IHoverService,
    @GlyphWorkbenchService private readonly glyphService: GlyphWorkbenchService,
  ) {
    super(
      options,
      keybindingService,
      contextMenuService,
      configurationService,
      contextKeyService,
      viewDescriptorService,
      instantiationService,
      openerService,
      themeService,
      hoverService,
    );
    this._register(this.glyphService.onDidChangeState(state => this.view.value?.update(state)));
  }

  protected override renderBody(container: HTMLElement): void {
    super.renderBody(container);
    // Dispose the old root before mounting if Code OSS recreates this body.
    this.view.clear();
    this.view.value = mountGlyphWorkbench(container, this.glyphService.state, {
      send: text => this.glyphService.send(text),
      cancel: () => this.glyphService.cancel(),
    });
  }
}
