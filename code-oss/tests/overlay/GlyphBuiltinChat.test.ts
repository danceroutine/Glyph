import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SyncDescriptor } from '#vs/platform/instantiation/common/descriptors.js';
import { Registry } from '#vs/platform/registry/common/platform.js';
import {
  Extensions,
  type IViewContainersRegistry,
  type IViewsRegistry,
  ViewContainerLocation,
} from '#vs/workbench/common/views.js';
import { GlyphBuiltinChat } from '#vs/workbench/contrib/glyph/browser/GlyphBuiltinChat.js';

vi.mock('#vs/workbench/contrib/chat/browser/chat.js', () => ({ ChatViewContainerId: 'workbench.panel.chat' }));
vi.mock('#vs/workbench/services/chat/common/chatEntitlementService.js', () => ({
  IChatEntitlementService: () => {},
}));

const containers = () => Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
const views = () => Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

describe(GlyphBuiltinChat, () => {
  it('identifies itself as a workbench contribution', () => {
    expect(GlyphBuiltinChat.ID).toBe('workbench.contrib.glyphBuiltinChat');
  });

  it('hides built-in chat and removes its views', () => {
    class Pane {}
    const container = containers().registerViewContainer(
      {
        id: 'workbench.panel.chat',
        title: { value: 'Chat', original: 'Chat' },
        ctorDescriptor: new SyncDescriptor(Pane),
      },
      ViewContainerLocation.AuxiliaryBar,
    );
    views().registerViews(
      [
        {
          id: 'workbench.panel.chat.view',
          name: { value: 'Chat', original: 'Chat' },
          ctorDescriptor: new SyncDescriptor(Pane),
        },
      ],
      container,
    );
    onTestFinished(() => {
      if (containers().get('workbench.panel.chat')) containers().deregisterViewContainer(container);
    });
    const chat = { setForceHidden: vi.fn() };

    expect(new GlyphBuiltinChat(chat as never)).toBeInstanceOf(GlyphBuiltinChat);

    expect(chat.setForceHidden).toHaveBeenCalledWith(true);
    expect(containers().get('workbench.panel.chat')).toBeUndefined();
    expect(views().getView('workbench.panel.chat.view')).toBeNull();
  });

  it('only hides built-in chat when its views are absent', () => {
    const chat = { setForceHidden: vi.fn() };

    expect(new GlyphBuiltinChat(chat as never)).toBeInstanceOf(GlyphBuiltinChat);

    expect(chat.setForceHidden).toHaveBeenCalledWith(true);
    expect(containers().get('workbench.panel.chat')).toBeUndefined();
  });
});
