import { BrowserViewCommandId } from '#vs/platform/browserView/common/browserView.js';
import { IFileDialogService } from '#vs/platform/dialogs/common/dialogs.js';
import { IFileService } from '#vs/platform/files/common/files.js';
import { VSBuffer } from '#vs/base/common/buffer.js';
import { ICommandService } from '#vs/platform/commands/common/commands.js';
import { getIconClasses } from '#vs/editor/common/services/getIconClasses.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ILanguageService } from '#vs/editor/common/languages/language.js';
import { URI } from '#vs/base/common/uri.js';
import { IPreferencesService } from '#vs/workbench/services/preferences/common/preferences.js';
import { StandardKeyboardEvent } from '#vs/base/browser/keyboardEvent.js';
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
import { IWorkbenchLayoutService, Parts } from '#vs/workbench/services/layout/browser/layoutService.js';
import { ViewContainerLocation, IViewDescriptorService } from '#vs/workbench/common/views.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import type { GlyphWorkbenchView } from '#glyph/workbench/GlyphWorkbenchView.js';
import { mountGlyphWorkbench } from './ui/mountGlyphWorkbench.js';

/**
 * Hosts Glyph in the native auxiliary bar, sharing the workbench's focus,
 * visibility, and disposal lifecycle.
 */
export class GlyphViewPane extends ViewPane {
  static readonly ID = 'workbench.view.glyph';
  private readonly view = this._register(new MutableDisposable<GlyphWorkbenchView>());

  constructor(
    options: IViewletViewOptions,
    @IFileDialogService private readonly dialogs: IFileDialogService,
    @IFileService private readonly files: IFileService,
    @ICommandService private readonly commands: ICommandService,
    @IKeybindingService private readonly glyphKeybindings: IKeybindingService,
    @IContextMenuService contextMenuService: IContextMenuService,
    @IConfigurationService configurationService: IConfigurationService,
    @IContextKeyService private readonly glyphContextKeys: IContextKeyService,
    @IViewDescriptorService private readonly glyphViewDescriptors: IViewDescriptorService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IOpenerService openerService: IOpenerService,
    @IThemeService themeService: IThemeService,
    @IHoverService hoverService: IHoverService,
    @IWorkbenchLayoutService private readonly glyphLayout: IWorkbenchLayoutService,
    @IPreferencesService private readonly preferences: IPreferencesService,
    @GlyphWorkbenchService private readonly glyphService: GlyphWorkbenchService,
  ) {
    super(
      options,
      glyphKeybindings,
      contextMenuService,
      configurationService,
      glyphContextKeys,
      glyphViewDescriptors,
      instantiationService,
      openerService,
      themeService,
      hoverService,
    );
    this._register(
      this.glyphKeybindings.onDidUpdateKeybindings(() => this.view.value?.update(this.glyphService.state)),
    );
    this._register(this.glyphService.onDidChangeState(state => this.view.value?.update(state)));
  }

  protected override renderBody(container: HTMLElement): void {
    super.renderBody(container);
    // Dispose the old root before mounting if Code OSS recreates this body.
    this.view.clear();
    const service = this.glyphService;
    this.view.value = mountGlyphWorkbench(container, this.glyphService.state, {
      get composer() {
        return service.composer;
      },
      composerKeybindings: {
        label: command => this.glyphKeybindings.lookupKeybinding(command)?.getLabel() ?? undefined,
        mount: element => {
          const scope = this.glyphContextKeys.createScoped(element);
          scope.createKey('glyph.composerFocus', true);
          return () => {
            scope.dispose();
          };
        },
        dispatch: event => {
          if (!(event.target instanceof Element)) return false;
          const handled = this.glyphKeybindings.dispatchEvent(new StandardKeyboardEvent(event), event.target);
          if (handled) event.stopPropagation();
          return handled;
        },
      },
      reconnectWorkspace: () => this.glyphService.connect(),
      reserveHistoryWidth: width => {
        const location = this.glyphViewDescriptors.getViewLocationById(this.id);
        const part =
          location === ViewContainerLocation.Sidebar
            ? Parts.SIDEBAR_PART
            : location === ViewContainerLocation.Panel
              ? Parts.PANEL_PART
              : Parts.AUXILIARYBAR_PART;
        const before = this.glyphLayout.getSize(part);
        this.glyphLayout.setSize(part, { ...before, width: before.width + width });
        // The workbench may clamp expansion when the editor has reached its minimum size.
        const addedWidth = Math.max(0, this.glyphLayout.getSize(part).width - before.width);
        return () => {
          const current = this.glyphLayout.getSize(part);
          this.glyphLayout.setSize(part, { ...current, width: current.width - addedWidth });
        };
      },
      managesQueue: true,
      moveQueuedToNewChat: id => service.moveQueuedToNewChat(id),
      openMessageSettings: () => {
        void this.preferences.openSettings({ query: 'glyph.chat.followUpBehavior' });
      },
      get followUpBehavior() {
        return service.followUpBehavior;
      },
      sendImmediately: (text, attachments, options) => service.sendImmediately(text, attachments, options),
      context: this.glyphService.context,
      steer: (text, attachments, options) => this.glyphService.steer(text, attachments, options),
      send: (text, attachments, options) => this.glyphService.send(text, attachments, options),
      branchChat: (chatId, turnId) => service.branchChat!(chatId, turnId),
      restoreCheckpoint: (chatId, turnId) => service.restoreCheckpoint!(chatId, turnId),
      openLink: href => service.openLink!(href),
      copyText: text => service.copyText(text),
      viewPlan: (chatId, plan) => service.viewPlan!(chatId, plan),
      selectMode: mode => service.selectMode!(mode),
      buildPlan: (chatId, plan, newChat) => service.buildPlan!(chatId, plan, newChat),
      cancel: () => {
        this.glyphService.cancel();
      },
      writeShellInput: (chatId, sessionId, input, appendNewline) =>
        this.glyphService.writeShellInput(chatId, sessionId, input, appendNewline),
      openShell: (chatId, sessionId) => this.glyphService.openShell(chatId, sessionId),
      stopShell: (chatId, sessionId) => this.glyphService.stopShell(chatId, sessionId),
      answerQuestion: (chatId, runId, questionId, answer) =>
        this.glyphService.answerQuestion(chatId, runId, questionId, answer),
      decideApproval: (chatId, runId, approvalId, decision) =>
        this.glyphService.decideApproval(chatId, runId, approvalId, decision),
      fileIconClasses: path =>
        this.instantiationService.invokeFunction(accessor =>
          getIconClasses(accessor.get(IModelService), accessor.get(ILanguageService), URI.file(path)),
        ),
      reviewProposalFile: (chatId, proposalId, fileId) => service.reviewProposalFile(chatId, proposalId, fileId),
      decideProposalItems: (chatId, items, accept) => service.decideProposalItems(chatId, items, accept),
      newChat: () => {
        this.glyphService.newChat();
      },
      closeChat: id => this.glyphService.closeChat(id),
      setChatArchived: (id, archived) => service.setChatArchived(id, archived),
      setChatPinned: (id, pinned) => {
        service.setChatPinned(id, pinned);
      },
      chatMenuActions: [
        {
          id: 'export',
          label: 'Export Transcript',
          run: async () => {
            const snapshot = service.state;
            const title = snapshot.chats.find(chat => chat.id === snapshot.selectedChatId)?.title ?? 'New chat';
            const transcript = `# ${title}\n\n${snapshot.transcript.map(entry => `## ${entry.role}\n\n${entry.text}`).join('\n\n')}\n`;
            const resource = await this.dialogs.showSaveDialog({
              title: 'Export Glyph transcript',
              filters: [{ name: 'Markdown', extensions: ['md'] }],
            });
            if (resource) await this.files.writeFile(resource, VSBuffer.fromString(transcript));
          },
        },
        {
          id: 'browser',
          label: 'Open Browser',
          run: () => this.commands.executeCommand<void>(BrowserViewCommandId.Open),
        },
        {
          id: 'settings',
          label: 'Agent Settings',
          run: () => this.preferences.openSettings({ query: 'glyph' }).then(() => {}),
        },
        {
          id: 'maximize',
          label: 'Toggle Maximized Chat',
          run: () => {
            this.glyphLayout.toggleMaximizedAuxiliaryBar();
          },
        },
        {
          id: 'hide',
          label: 'Hide Chat',
          run: () => {
            this.glyphLayout.setPartHidden(true, Parts.AUXILIARYBAR_PART);
          },
        },
      ],
      openChat: id => this.glyphService.openChat(id),
      selectAccount: (provider, id) => this.glyphService.selectAccount(provider, id),
      selectModel: model => this.glyphService.selectModel(model),
    });
  }
}
