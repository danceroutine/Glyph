import { Registry } from '#vs/platform/registry/common/platform.js';
import { Extensions, IViewContainersRegistry, IViewsRegistry } from '#vs/workbench/common/views.js';
import { ChatViewContainerId } from '#vs/workbench/contrib/chat/browser/chat.js';
import { IChatEntitlementService } from '#vs/workbench/services/chat/common/chatEntitlementService.js';

/** Glyph owns chat; keep upstream services available without their competing UI. */
export class GlyphBuiltinChat {
  static readonly ID = 'workbench.contrib.glyphBuiltinChat';

  constructor(@IChatEntitlementService chat: IChatEntitlementService) {
    // Code OSS has no defaultChatAgent, so its entitlement service does not
    // observe chat.disableAIFeatures. Use the supported fallback context too.
    chat.setForceHidden(true);
    const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
    const container = containers.get(ChatViewContainerId);
    if (container) {
      const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
      views.deregisterViews(views.getViews(container), container);
      containers.deregisterViewContainer(container);
    }
  }
}
