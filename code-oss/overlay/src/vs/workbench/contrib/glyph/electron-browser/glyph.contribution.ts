import { GlyphFollowUpBehavior } from '#glyph/workbench/GlyphFollowUpBehavior.js';
import { GlyphComposerCommand } from '#glyph/workbench/GlyphComposerCommand.js';
import { ContextKeyExpr } from '#vs/platform/contextkey/common/contextkey.js';
import {
  ConfigurationScope,
  Extensions as ConfigurationExtensions,
  IConfigurationRegistry,
} from '#vs/platform/configuration/common/configurationRegistry.js';
import { GlyphPlanEditor, GlyphPlanInput } from '#vs/workbench/contrib/glyph/browser/GlyphPlanEditor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '#vs/workbench/browser/editor.js';
import { EditorExtensions } from '#vs/workbench/common/editor.js';
import { registerAction2, Action2 } from '#vs/platform/actions/common/actions.js';
import { KeyCode, KeyMod } from '#vs/base/common/keyCodes.js';
import { KeybindingWeight } from '#vs/platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '#vs/editor/common/editorContextKeys.js';
import { IViewsService } from '#vs/workbench/services/views/common/viewsService.js';
import type { ServicesAccessor } from '#vs/platform/instantiation/common/instantiation.js';
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

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
  id: 'glyph',
  title: 'Glyph',
  type: 'object',
  properties: {
    'glyph.chat.followUpBehavior': {
      type: 'string',
      enum: Object.values(GlyphFollowUpBehavior),
      default: GlyphFollowUpBehavior.QUEUE,
      enumDescriptions: [
        'Wait for the active response to finish, then send queued messages in order.',
        'Cancel the active response and start a new turn with the message.',
      ],
      scope: ConfigurationScope.APPLICATION,
      description: 'What Send Message does while Glyph is responding. Steer always updates the existing work.',
    },
    'glyph.modeSwitch.autoApprove': {
      type: 'boolean',
      default: false,
      scope: ConfigurationScope.APPLICATION,
      description:
        'Automatically approve agent-requested mode switches when the countdown ends. When disabled, unanswered switches are denied.',
    },
    'glyph.modeSwitch.timeoutSeconds': {
      type: 'integer',
      default: 15,
      minimum: 5,
      maximum: 300,
      scope: ConfigurationScope.APPLICATION,
      description: 'Seconds to wait for approval of an agent-requested mode switch.',
    },
  },
});

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

registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: 'glyph.attachSelection',
        title: localize2('glyph.attachSelection', 'Attach Selection to Glyph'),
        keybinding: {
          primary: KeyMod.CtrlCmd | KeyCode.KeyL,
          weight: KeybindingWeight.WorkbenchContrib,
          when: EditorContextKeys.editorTextFocus,
        },
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const glyph = accessor.get(GlyphWorkbenchService);
      const views = accessor.get(IViewsService);
      await glyph.attachSelection();
      await views.openView(GlyphViewPane.ID, true);
      glyph.composer.focus();
    }
  },
);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
  EditorPaneDescriptor.create(GlyphPlanEditor, GlyphPlanEditor.ID, 'Glyph Plan'),
  [new SyncDescriptor(GlyphPlanInput)],
);

for (const command of [
  {
    id: GlyphComposerCommand.SEND,
    title: localize2('glyph.sendMessage', 'Glyph: Send Message'),
    primary: KeyCode.Enter,
  },
  {
    id: GlyphComposerCommand.STEER,
    title: localize2('glyph.steerMessage', 'Glyph: Steer Current Response'),
    primary: KeyMod.CtrlCmd | KeyCode.Enter,
  },
  {
    id: GlyphComposerCommand.INSERT_NEWLINE,
    title: localize2('glyph.insertNewline', 'Glyph: Insert Newline'),
    primary: KeyMod.Shift | KeyCode.Enter,
  },
]) {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: command.id,
          title: command.title,
          f1: true,
          precondition: ContextKeyExpr.has('glyph.composerFocus'),
          keybinding: {
            primary: command.primary,
            weight: KeybindingWeight.WorkbenchContrib,
            when: ContextKeyExpr.has('glyph.composerFocus'),
          },
        });
      }
      run(accessor: ServicesAccessor): void {
        accessor.get(GlyphWorkbenchService).composer.executeCommand(command.id);
      }
    },
  );
}
