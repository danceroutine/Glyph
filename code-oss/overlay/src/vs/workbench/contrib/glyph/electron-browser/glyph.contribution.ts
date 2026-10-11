import { Codicon } from '#vs/base/common/codicons.js';
import { localize, localize2 } from '#vs/nls.js';
import { InstantiationType, registerSingleton } from '#vs/platform/instantiation/common/extensions.js';
import { Registry } from '#vs/platform/registry/common/platform.js';
import { registerIcon } from '#vs/platform/theme/common/iconRegistry.js';
import { SyncDescriptor } from '#vs/platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '#vs/workbench/browser/parts/views/viewPaneContainer.js';
import {
  Extensions,
  IViewContainersRegistry,
  IViewDescriptor,
  IViewsRegistry,
  ViewContainerLocation,
} from '#vs/workbench/common/views.js';
import { GlyphViewPane } from '#vs/workbench/contrib/glyph/browser/GlyphViewPane.js';
import { NativeGlyphWorkbenchService } from '#vs/workbench/contrib/glyph/browser/NativeGlyphWorkbenchService.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';

const containerId = 'workbench.view.glyphContainer';
const icon = registerIcon('glyph-view-icon', Codicon.sparkle, localize('glyphViewIcon', 'Glyph view icon.'));
const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

// Registering at contribution load makes the service available through Code OSS
// DI without introducing an extension host or a second webview runtime.
registerSingleton(GlyphWorkbenchService, NativeGlyphWorkbenchService, InstantiationType.Delayed);

const container = containers.registerViewContainer(
  {
    id: containerId,
    title: localize2('glyph', 'Glyph'),
    icon,
    ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
      containerId,
      { mergeViewWithContainerWhenSingleView: true },
    ]),
    storageId: containerId,
    order: 1,
  },
  ViewContainerLocation.AuxiliaryBar,
);

const descriptor: IViewDescriptor = {
  id: GlyphViewPane.ID,
  name: localize2('glyph', 'Glyph'),
  containerIcon: icon,
  ctorDescriptor: new SyncDescriptor(GlyphViewPane),
  canToggleVisibility: true,
  canMoveView: true,
  openCommandActionDescriptor: { id: 'glyph.focus', title: localize2('glyph.focus', 'Focus Glyph') },
};
views.registerViews([descriptor], container);
