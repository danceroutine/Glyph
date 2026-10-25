import { GlyphAgentReviewScope, glyphAgentReviewLabels } from '#glyph/workbench/GlyphAgentReview.js';
import { GlyphAgentReviewPane } from '#vs/workbench/contrib/glyph/browser/GlyphAgentReviewPane.js';
import { GlyphBuiltinChat } from '#vs/workbench/contrib/glyph/browser/GlyphBuiltinChat.js';
import {
  GlyphDiagnosticHover,
  GlyphTerminalSelectionActions,
  useGlyphContext,
} from '#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js';
import { HoverParticipantRegistry } from '#vs/editor/contrib/hover/browser/hoverTypes.js';
import { WorkbenchPhase, registerWorkbenchContribution2 } from '#vs/workbench/common/contributions.js';
import { VIEWLET_ID as SCM_VIEWLET_ID } from '#vs/workbench/contrib/scm/common/scm.js';
import { TerminalContextKeys } from '#vs/workbench/contrib/terminal/common/terminalContextKey.js';
import type { ITestMessageMenuArgs } from '#vs/workbench/contrib/testing/common/testTypes.js';
import { AgentModeID } from '#glyph/protocol/index.js';
import { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
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
import { registerAction2, Action2, MenuId } from '#vs/platform/actions/common/actions.js';
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
import { INotificationService } from '#vs/platform/notification/common/notification.js';
import { URI } from '#vs/base/common/uri.js';
import { IExplorerService } from '#vs/workbench/contrib/files/browser/files.js';
import { ExplorerFolderContext } from '#vs/workbench/contrib/files/common/files.js';
import { GlyphAgentInstructionsPreferences } from '#vs/workbench/contrib/glyph/browser/GlyphAgentInstructionsPreferences.js';
import {
  Extensions as PreferencesExtensions,
  type IPreferencesEditorPaneRegistry,
} from '#vs/workbench/contrib/preferences/browser/preferencesEditorRegistry.js';

abstract class AsyncAction2 extends Action2 {
  abstract override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void>;
}

for (const folder of [false, true]) {
  for (const newChat of [false, true]) {
    const kind = folder ? 'Directory' : 'File';
    const id = `glyph.addExplorer${kind}To${newChat ? 'New' : ''}Chat`;
    registerAction2(
      class extends AsyncAction2 {
        constructor() {
          super({
            id,
            title: localize2(id, 'Add {0} to {1}Glyph Chat', kind, newChat ? 'New ' : ''),
            precondition: ContextKeyExpr.equals('isWorkspaceTrusted', true),
            menu: {
              id: MenuId.ExplorerContext,
              group: '7_glyph',
              order: newChat ? 2 : 1,
              when: ContextKeyExpr.and(
                ContextKeyExpr.equals('resourceScheme', 'file'),
                folder ? ExplorerFolderContext : ExplorerFolderContext.negate(),
              ),
            },
          });
        }
        async run(accessor: ServicesAccessor, resource?: URI): Promise<void> {
          const selected = accessor.get(IExplorerService).getContext(true);
          const resources =
            resource && !selected.some(item => item.resource.toString() === resource.toString())
              ? [resource]
              : selected.map(item => item.resource);
          const glyph = accessor.get(GlyphWorkbenchService);
          const notifications = accessor.get(INotificationService);
          const views = accessor.get(IViewsService);
          try {
            await glyph.attachExplorerResources(
              resources.map(uri => uri.toString()),
              newChat,
            );
          } catch (error) {
            notifications.error(error instanceof Error ? error : String(error));
            return;
          }
          await views.openView(GlyphViewPane.ID, true);
          glyph.composer.focus();
        }
      },
    );
  }
}

// Match the design previews without overriding an explicitly selected user theme.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([
  {
    overrides: {
      'workbench.colorTheme': 'Dark Modern',
      'workbench.preferredDarkColorTheme': 'Dark Modern',
      'workbench.preferredLightColorTheme': 'Light Modern',
      'chat.disableAIFeatures': true,
    },
  },
]);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
  id: 'glyph',
  title: 'Glyph',
  type: 'object',
  properties: {
    'glyph.review.scope': {
      type: 'string',
      enum: Object.values(GlyphAgentReviewScope),
      enumItemLabels: Object.values(glyphAgentReviewLabels),
      default: GlyphAgentReviewScope.LAST_COMMIT,
      scope: ConfigurationScope.WINDOW,
      description: 'Default comparison for Agent Review in Source Control.',
    },
    'glyph.review.baseBranch': {
      type: 'string',
      default: '',
      scope: ConfigurationScope.RESOURCE,
      description: 'Git branch ref used by Agent Review when comparing against a branch.',
    },
    'glyph.preferOpeningWebLinksInGlyph': {
      type: 'boolean',
      default: false,
      scope: ConfigurationScope.APPLICATION,
      description: 'Prefer opening web links in Glyph’s integrated browser instead of the system browser.',
    },
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

Registry.as<IPreferencesEditorPaneRegistry>(PreferencesExtensions.PreferencesEditorPane).registerPreferencesEditorPane({
  id: 'glyph.agentInstructions',
  title: localize('glyphAgentInstructionsSettings', 'Agent Instructions'),
  icon: Codicon.book,
  order: 10,
  ctorDescriptor: new SyncDescriptor(GlyphAgentInstructionsPreferences),
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
  class extends AsyncAction2 {
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
      const viewsService = accessor.get(IViewsService);
      await glyph.attachSelection();
      await viewsService.openView(GlyphViewPane.ID, true);
      glyph.composer.focus();
    }
  },
);

registerAction2(
  class extends AsyncAction2 {
    constructor() {
      super({
        id: 'glyph.attachIdeContext',
        title: localize2('glyph.attachIdeContext', 'Glyph: Attach IDE Context'),
        f1: true,
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const glyph = accessor.get(GlyphWorkbenchService);
      const viewsService = accessor.get(IViewsService);
      await glyph.attachIdeContext();
      await viewsService.openView(GlyphViewPane.ID, true);
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

const reviewWhen = ContextKeyExpr.and(
  ContextKeyExpr.has('glyph.reviewEditor'),
  ContextKeyExpr.not('glyph.reviewTextInput'),
);
for (const command of [
  { id: GlyphReviewCommand.ADD_TO_CHAT, title: 'Glyph: Add Selection to Chat', primary: KeyMod.CtrlCmd | KeyCode.KeyL },
  { id: GlyphReviewCommand.KEEP, title: 'Glyph: Keep Change', primary: KeyMod.CtrlCmd | KeyCode.KeyY },
  { id: GlyphReviewCommand.UNDO, title: 'Glyph: Undo Change', primary: KeyMod.CtrlCmd | KeyCode.KeyN },
  {
    id: GlyphReviewCommand.COMMENT,
    title: 'Glyph: Reject Change with Comment',
    primary: KeyMod.CtrlCmd | KeyCode.KeyR,
  },
  { id: GlyphReviewCommand.KEEP_FILE, title: 'Glyph: Keep File', primary: KeyMod.CtrlCmd | KeyCode.Enter },
  {
    id: GlyphReviewCommand.UNDO_FILE,
    title: 'Glyph: Undo File',
    primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Backspace,
  },
  {
    id: GlyphReviewCommand.KEEP_ALL,
    title: 'Glyph: Keep All Changes',
    primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
  },
  {
    id: GlyphReviewCommand.NEXT_FILE,
    title: 'Glyph: Review Next File',
    primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.RightArrow,
  },
  {
    id: GlyphReviewCommand.PREVIOUS_FILE,
    title: 'Glyph: Review Previous File',
    primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.LeftArrow,
  },
  { id: GlyphReviewCommand.NEXT_CHANGE, title: 'Glyph: Review Next Change', primary: KeyMod.Alt | KeyCode.DownArrow },
  {
    id: GlyphReviewCommand.PREVIOUS_CHANGE,
    title: 'Glyph: Review Previous Change',
    primary: KeyMod.Alt | KeyCode.UpArrow,
  },
]) {
  registerAction2(
    class extends Action2 {
      constructor() {
        super({
          id: command.id,
          title: localize2(command.id, command.title),
          f1: true,
          precondition:
            command.id === GlyphReviewCommand.ADD_TO_CHAT
              ? ContextKeyExpr.and(reviewWhen, ContextKeyExpr.has('editorHasSelection'))
              : reviewWhen,
          // Review defaults take precedence over editor navigation only inside a review editor.
          keybinding: {
            primary: command.primary,
            // Development builds bind Cmd/Ctrl+R to Reload at +50.
            weight: KeybindingWeight.WorkbenchContrib + (command.id === GlyphReviewCommand.COMMENT ? 51 : 1),
            when:
              command.id === GlyphReviewCommand.ADD_TO_CHAT
                ? ContextKeyExpr.and(reviewWhen, ContextKeyExpr.has('editorHasSelection'))
                : reviewWhen,
          },
        });
      }
      run(accessor: ServicesAccessor): void {
        accessor.get(GlyphWorkbenchService).executeReviewCommand(command.id);
      }
    },
  );
}

HoverParticipantRegistry.register(GlyphDiagnosticHover);
registerWorkbenchContribution2(GlyphBuiltinChat.ID, GlyphBuiltinChat, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(
  GlyphTerminalSelectionActions.ID,
  GlyphTerminalSelectionActions,
  WorkbenchPhase.AfterRestored,
);
export function registerGlyphAgentReviewView(
  viewContainers: IViewContainersRegistry,
  viewRegistry: IViewsRegistry,
): void {
  const scmContainer = viewContainers.get(SCM_VIEWLET_ID);
  if (!scmContainer) return;
  viewRegistry.registerViews(
    [
      {
        id: GlyphAgentReviewPane.ID,
        name: localize2('glyph.agentReview', 'Agent Review'),
        ctorDescriptor: new SyncDescriptor(GlyphAgentReviewPane),
        canToggleVisibility: true,
        canMoveView: true,
        order: 1.5,
        openCommandActionDescriptor: {
          id: 'glyph.openAgentReview',
          title: localize2('glyph.openAgentReview', 'Glyph: Open Agent Review'),
        },
      },
    ],
    scmContainer,
  );
}
registerGlyphAgentReviewView(containers, views);

registerAction2(
  class extends AsyncAction2 {
    constructor() {
      super({
        id: 'glyph.attachTerminalSelection',
        title: localize2('glyph.attachTerminalSelection', 'Add to Chat'),
        precondition: TerminalContextKeys.textSelected,
        keybinding: {
          primary: KeyMod.CtrlCmd | KeyCode.KeyL,
          weight: KeybindingWeight.WorkbenchContrib + 1,
          when: ContextKeyExpr.and(TerminalContextKeys.focus, TerminalContextKeys.textSelected),
        },
        menu: {
          id: MenuId.TerminalInstanceContext,
          group: 'navigation',
          order: 2,
          when: TerminalContextKeys.textSelected,
        },
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const glyph = accessor.get(GlyphWorkbenchService);
      await useGlyphContext(glyph, accessor.get(IViewsService), () => glyph.ideContext.terminal());
    }
  },
);
registerAction2(
  class extends AsyncAction2 {
    constructor() {
      super({
        id: 'glyph.fixTestFailure',
        title: localize2('glyph.fixTestFailure', 'Fix with Agent'),
        menu: [
          { id: MenuId.TestMessageContent, group: 'navigation', order: 1 },
          { id: MenuId.TestMessageContext, group: 'navigation', order: 1 },
        ],
      });
    }
    async run(
      accessor: ServicesAccessor,
      context?: ITestMessageMenuArgs & { glyphResultId?: string; glyphTaskIndex?: number; glyphMessageIndex?: number },
    ): Promise<void> {
      if (
        context?.glyphResultId === undefined ||
        context?.glyphResultId === '' ||
        context.glyphTaskIndex === undefined ||
        context.glyphMessageIndex === undefined
      )
        throw new Error('Open the test failure message to fix it with Glyph.');
      const glyph = accessor.get(GlyphWorkbenchService);
      await useGlyphContext(
        glyph,
        accessor.get(IViewsService),
        () =>
          glyph.ideContext.captureTestFailure(
            context.glyphResultId!,
            context.test.item.extId,
            context.glyphTaskIndex!,
            context.glyphMessageIndex!,
          ),
        'Investigate and fix the attached test failure. Check its source and run identity, reproduce when possible, and verify the fix.',
        AgentModeID.AGENT,
      );
    }
  },
);
