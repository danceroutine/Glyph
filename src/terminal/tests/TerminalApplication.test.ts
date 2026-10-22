import { describe, expect, it, vi } from 'vitest';
import type { GlyphService } from '#src/application/GlyphService.js';
import type { ChatAccount } from '#src/chat/ChatAccount.js';
import type { Model } from '#src/chat/Model.js';
import type { ChatSession } from '#src/chat/sessions/ChatSession.js';
import type { ChatSessionSummary } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatAuthorizationHandler } from '#src/chat/ChatAuthorizationRequest.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { ShellWakeEvent } from '#src/shell/ShellWakeEvent.js';
import { AccountSelectionType } from '#src/terminal/AccountSelectionType.js';
import { TerminalActionType } from '#src/terminal/TerminalActionType.js';
import { TerminalApplication } from '#src/terminal/TerminalApplication.js';
import type { TerminalUI } from '#src/terminal/TerminalUI.js';
import type { TerminalEditReviewer } from '#src/terminal/ui/proposal/TerminalEditReviewer.js';

type TerminalAction = Awaited<ReturnType<TerminalUI['nextAction']>>;
type AccountSelection = Awaited<ReturnType<TerminalUI['chooseAccount']>>;

describe(TerminalApplication, () => {
  describe(TerminalApplication.prototype.run, () => {
    it('exits quietly when shutdown begins during initialization', async () => {
      const harness = createHarness();
      harness.glyph.initialize.mockImplementation(async () => {
        harness.shutdown.abort();
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.showWelcome).not.toHaveBeenCalled();
      expect(harness.glyph.dispose).toHaveBeenCalledOnce();
    });

    it('greets the user, activates a connected account, and starts a chat with the chosen model', async () => {
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }] });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.showWelcome).toHaveBeenCalledWith(
        harness.projectContext,
        '/state/trace.log',
        false,
        harness.glyph.providerPresentation,
      );
      expect(harness.ui.chooseAccount).toHaveBeenCalledWith(
        [harness.account],
        harness.glyph.providerPresentation,
        harness.shutdown.signal,
      );
      expect(harness.glyph.signIn).not.toHaveBeenCalled();
      expect(harness.ui.chooseModel).toHaveBeenCalledWith(
        [{ slug: 'model', name: 'Model' }],
        undefined,
        harness.shutdown.signal,
      );
      expect(harness.glyph.createChat).toHaveBeenCalledWith(harness.account, { slug: 'model', name: 'Model' });
      expect(harness.ui.showActive).toHaveBeenCalledWith(
        harness.account,
        { slug: 'model', name: 'Model' },
        harness.glyph.providerPresentation,
      );
      expect(harness.active.setTraceEnabled).toHaveBeenCalledWith(false);
      expect(harness.ui.showChatActivated).toHaveBeenCalledWith(
        harness.active.session.summary,
        harness.active.session.transcript,
      );
      expect(harness.glyph.commitReviewResults).toHaveBeenCalledWith(harness.active.session, {
        signal: harness.shutdown.signal,
      });
      expect(harness.ui.nextAction).toHaveBeenCalledWith(harness.shutdown.signal, 0);
      expect(harness.glyph.dispose).toHaveBeenCalledOnce();
    });

    it('resumes the saved chat that already uses the chosen model', async () => {
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }] });
      const saved = chatSession('saved-chat');
      harness.glyph.listChats.mockReturnValue([chatSummary('other-chat', 'other-model'), saved.session.summary]);
      harness.glyph.openChat.mockReturnValue(saved.session);

      await harness.application.run();

      expect(harness.glyph.openChat).toHaveBeenCalledWith('saved-chat', harness.account);
      expect(harness.glyph.createChat).not.toHaveBeenCalled();
      expect(harness.ui.showChatActivated).toHaveBeenCalledWith(saved.session.summary, saved.session.transcript);
    });

    it('passes the configured model to model selection', async () => {
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }], configuredModel: 'model' });

      await harness.application.run();

      expect(harness.ui.chooseModel).toHaveBeenCalledWith(
        [{ slug: 'model', name: 'Model' }],
        'model',
        harness.shutdown.signal,
      );
    });

    it('signs in a new account when the user chooses to add one', async () => {
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }] });
      const request = { url: 'https://auth.example/add', title: 'Sign in', message: 'Continue in the browser.' };
      harness.ui.chooseAccount.mockResolvedValue({ type: AccountSelectionType.ADD });
      harness.glyph.signIn.mockImplementation(async (_existing, _access, authorize) => {
        await authorize?.(request);
        return harness.account;
      });

      await harness.application.run();

      expect(harness.glyph.signIn).toHaveBeenCalledWith(undefined, false, expect.any(Function));
      expect(harness.ui.authorize).toHaveBeenCalledWith(request);
    });

    it('signs in again before using a signed-out account', async () => {
      const signedOut = chatAccount({ connected: false });
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }], account: signedOut });
      const request = { url: 'https://auth.example/renew', title: 'Renew', message: 'Sign in again.' };
      harness.glyph.signIn.mockImplementation(async (_existing, _access, authorize) => {
        await authorize?.(request);
        return chatAccount();
      });

      await harness.application.run();

      expect(harness.glyph.signIn).toHaveBeenCalledWith(signedOut, false, expect.any(Function));
      expect(harness.ui.authorize).toHaveBeenCalledWith(request);
      expect(harness.glyph.createChat).toHaveBeenCalledWith(chatAccount(), { slug: 'model', name: 'Model' });
    });

    it('enables model access with consent before continuing with an account that lacks it', async () => {
      const limited = chatAccount({ inferenceAccess: false, accessPrompt: 'Allow Glyph to use models?' });
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }], account: limited });
      const request = { url: 'https://auth.example/access', title: 'Access', message: 'Approve model access.' };
      harness.ui.confirmInferenceAccess.mockResolvedValue(true);
      harness.glyph.signIn.mockImplementation(async (_existing, _access, authorize) => {
        await authorize?.(request);
        return chatAccount();
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.confirmInferenceAccess).toHaveBeenCalledWith(
        'Allow Glyph to use models?',
        harness.shutdown.signal,
      );
      expect(harness.glyph.signIn).toHaveBeenCalledWith(limited, true, expect.any(Function));
      expect(harness.ui.authorize).toHaveBeenCalledWith(request);
    });

    it('stops without sending inference when model access is declined', async () => {
      const limited = chatAccount({ inferenceAccess: false });
      const harness = createHarness({ account: limited });

      await expect(harness.application.run()).resolves.toBe(1);

      expect(harness.ui.confirmInferenceAccess).toHaveBeenCalledWith('Enable model access?', harness.shutdown.signal);
      expect(harness.ui.showError).toHaveBeenCalledWith('Model access remains disabled. No inference was sent.');
      expect(harness.glyph.listModels).not.toHaveBeenCalled();
      expect(harness.glyph.dispose).toHaveBeenCalledOnce();
    });

    it('requires the user to acknowledge an account notice before listing models', async () => {
      const notice = { message: 'Preview terms changed.', acknowledgementPrompt: 'Press Enter to continue.' };
      const noticed = chatAccount({ notice });
      const harness = createHarness({ actions: [{ type: TerminalActionType.EXIT }], account: noticed });

      await harness.application.run();

      expect(harness.ui.acknowledgeAccountNotice).toHaveBeenCalledWith(notice, harness.shutdown.signal);
      expect(harness.glyph.acknowledgeAccountNotice).toHaveBeenCalledWith(noticed);
      expect(harness.glyph.listModels).toHaveBeenCalledWith(noticed, harness.shutdown.signal);
    });

    it('reports a startup failure with secrets redacted and exits with failure', async () => {
      const harness = createHarness();
      harness.glyph.initialize.mockRejectedValue(new Error('secret store is locked'));

      await expect(harness.application.run()).resolves.toBe(1);

      expect(harness.ui.showError).toHaveBeenCalledWith('[REDACTED] store is locked');
      expect(harness.glyph.dispose).toHaveBeenCalledOnce();
    });

    it('stays quiet about a failure caused by shutdown', async () => {
      const harness = createHarness();
      harness.ui.chooseAccount.mockImplementation(async () => {
        harness.shutdown.abort();
        throw new Error('Prompt aborted.');
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.showError).not.toHaveBeenCalled();
    });

    it('stops background shells and still disposes the service when shell cleanup fails', async () => {
      const shells = shellSessions();
      const failure = new Error('shell cleanup failed');
      shells.dispose.mockRejectedValue(failure);
      const harness = createHarness({
        actions: [{ type: TerminalActionType.EXIT }],
        shellSessions: shells as unknown as ShellSessionManager,
      });

      await expect(harness.application.run()).rejects.toBe(failure);

      expect(shells.dispose).toHaveBeenCalledOnce();
      expect(harness.glyph.dispose).toHaveBeenCalledOnce();
    });

    it('stops prompting once shutdown begins while handling a command', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.HELP }, { type: TerminalActionType.HELP }],
      });
      harness.ui.showHelp.mockImplementation(() => {
        harness.shutdown.abort();
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.nextAction).toHaveBeenCalledOnce();
    });

    it('shows help', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.HELP }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.ui.showHelp).toHaveBeenCalledOnce();
    });

    it('clears the active conversation', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.RESET }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.active.reset).toHaveBeenCalledOnce();
      expect(harness.ui.showConversationReset).toHaveBeenCalledOnce();
    });

    it('starts a new chat with the active model', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.NEW_CHAT }, { type: TerminalActionType.EXIT }],
      });
      const fresh = chatSession('fresh-chat');
      harness.glyph.createChat.mockResolvedValueOnce(harness.active.session).mockResolvedValueOnce(fresh.session);

      await harness.application.run();

      expect(harness.glyph.createChat).toHaveBeenLastCalledWith(harness.account, { slug: 'model', name: 'Model' });
      expect(harness.ui.showChatActivated).toHaveBeenLastCalledWith(fresh.session.summary, fresh.session.transcript);
    });

    it('reports a chat that cannot be started and keeps prompting', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.NEW_CHAT }, { type: TerminalActionType.EXIT }],
      });
      harness.glyph.createChat
        .mockResolvedValueOnce(harness.active.session)
        .mockRejectedValueOnce(new Error('secret storage full'));

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.showError).toHaveBeenCalledWith('[REDACTED] storage full');
      expect(harness.ui.nextAction).toHaveBeenCalledTimes(2);
    });

    it('lists the account chats and marks the active one', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.LIST_CHATS }, { type: TerminalActionType.EXIT }],
      });
      const chats = [chatSummary('older-chat', 'other-model')];
      harness.glyph.listChats.mockReturnValue(chats);

      await harness.application.run();

      expect(harness.glyph.listChats).toHaveBeenLastCalledWith(harness.account);
      expect(harness.ui.showChats).toHaveBeenCalledWith(chats, 'active-chat');
    });

    it('switches to another saved chat', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.SWITCH_CHAT, chatId: 'other-chat' }, { type: TerminalActionType.EXIT }],
      });
      const other = chatSession('other-chat');
      harness.glyph.openChat.mockReturnValue(other.session);

      await harness.application.run();

      expect(harness.glyph.openChat).toHaveBeenCalledWith('other-chat', harness.account);
      expect(harness.ui.showChatActivated).toHaveBeenLastCalledWith(other.session.summary, other.session.transcript);
    });

    it('reports a saved chat that cannot be opened', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.SWITCH_CHAT, chatId: 'missing' }, { type: TerminalActionType.EXIT }],
      });
      harness.glyph.openChat.mockImplementation(() => {
        throw new Error('No secret chat matches.');
      });

      await harness.application.run();

      expect(harness.ui.showError).toHaveBeenCalledWith('No [REDACTED] chat matches.');
    });

    it('renames the active chat', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.RENAME_CHAT, title: 'Release notes' }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.glyph.renameChat).toHaveBeenCalledWith('active-chat', 'Release notes');
      expect(harness.ui.showChatRenamed).toHaveBeenCalledWith('Release notes');
    });

    it('reports a rejected chat title', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.RENAME_CHAT, title: '' }, { type: TerminalActionType.EXIT }],
      });
      harness.glyph.renameChat.mockRejectedValue(new Error('Chat title cannot be empty.'));

      await harness.application.run();

      expect(harness.ui.showError).toHaveBeenCalledWith('Chat title cannot be empty.');
      expect(harness.ui.showChatRenamed).not.toHaveBeenCalled();
    });

    it('shows aggregate usage', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.USAGE }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.ui.showUsage).toHaveBeenCalledWith(harness.glyph.usage);
    });

    it('turns provider tracing on for the service and the active chat', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.TRACE, enabled: true }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.glyph.setTraceEnabled).toHaveBeenCalledWith(true);
      expect(harness.active.setTraceEnabled).toHaveBeenLastCalledWith(true);
      expect(harness.ui.showTrace).toHaveBeenCalledWith(true, '/state/trace.log');
    });

    it('reports the current tracing state when no setting is given', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.TRACE }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.glyph.setTraceEnabled).toHaveBeenCalledWith(false);
      expect(harness.ui.showTrace).toHaveBeenCalledWith(false, '/state/trace.log');
    });

    it('signs out and exits', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.LOGOUT }, { type: TerminalActionType.HELP }],
      });
      harness.glyph.logout.mockResolvedValue(false);

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.glyph.logout).toHaveBeenCalledWith(harness.account);
      expect(harness.ui.showLogout).toHaveBeenCalledWith(false);
      expect(harness.ui.showHelp).not.toHaveBeenCalled();
    });

    it('opens the interactive review for active proposals at startup and on request', async () => {
      const reviewer = { review: vi.fn(async () => {}) };
      const harness = createHarness({
        actions: [{ type: TerminalActionType.REVIEW }, { type: TerminalActionType.EXIT }],
        reviewer: reviewer as unknown as TerminalEditReviewer,
      });
      const reviews = proposalReviews({ active: true, pendingChangeCount: 3 });
      harness.glyph.proposalReviews = reviews;

      await harness.application.run();

      expect(reviewer.review).toHaveBeenCalledTimes(2);
      expect(reviewer.review).toHaveBeenCalledWith(reviews, harness.shutdown.signal);
      expect(harness.ui.nextAction).toHaveBeenCalledWith(harness.shutdown.signal, 3);
      expect(harness.glyph.commitReviewResults).toHaveBeenCalledTimes(2);
    });

    it('delivers review results without an interactive review when no reviewer is available', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.REVIEW }, { type: TerminalActionType.EXIT }],
      });
      harness.glyph.proposalReviews = proposalReviews({ active: true });

      await harness.application.run();

      expect(harness.glyph.commitReviewResults).toHaveBeenCalledTimes(2);
    });

    it.each([
      { type: TerminalActionType.ACCEPT_ALL, decision: 'acceptAll' },
      { type: TerminalActionType.REJECT_ALL, decision: 'rejectAll' },
    ] as const)(
      'applies the $decision decision to every proposal and delivers the results',
      async ({ type, decision }) => {
        const harness = createHarness({ actions: [{ type }, { type: TerminalActionType.EXIT }] });
        const reviews = proposalReviews();
        harness.glyph.proposalReviews = reviews;

        await harness.application.run();

        expect(reviews[decision]).toHaveBeenCalledOnce();
        expect(harness.glyph.commitReviewResults).toHaveBeenCalledTimes(2);
      },
    );

    it.each([TerminalActionType.ACCEPT_ALL, TerminalActionType.REJECT_ALL] as const)(
      'still delivers results for %s when the host has no proposal reviews',
      async type => {
        const harness = createHarness({ actions: [{ type }, { type: TerminalActionType.EXIT }] });

        await harness.application.run();

        expect(harness.glyph.commitReviewResults).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      { type: TerminalActionType.ACCEPT_ALL, decision: 'acceptAll' },
      { type: TerminalActionType.REJECT_ALL, decision: 'rejectAll' },
    ] as const)('reports a failed $decision decision and keeps prompting', async ({ type, decision }) => {
      const harness = createHarness({ actions: [{ type }, { type: TerminalActionType.EXIT }] });
      const reviews = proposalReviews();
      reviews[decision].mockRejectedValue(new Error('secret file changed'));
      harness.glyph.proposalReviews = reviews;

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.showError).toHaveBeenCalledWith('[REDACTED] file changed');
    });

    it('switches accounts and selects a model for the new account', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.ACCOUNT }, { type: TerminalActionType.EXIT }],
      });
      const second = chatAccount({ id: 'account-2' });
      harness.ui.chooseAccount
        .mockResolvedValueOnce({ type: AccountSelectionType.ACCOUNT, account: harness.account })
        .mockResolvedValueOnce({ type: AccountSelectionType.ACCOUNT, account: second });

      await harness.application.run();

      expect(harness.ui.chooseAccount).toHaveBeenCalledTimes(2);
      expect(harness.glyph.listModels).toHaveBeenLastCalledWith(second, harness.shutdown.signal);
      expect(harness.glyph.createChat).toHaveBeenLastCalledWith(second, { slug: 'model', name: 'Model' });
    });

    it('signs in again with the active account and keeps its existing model access', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.LOGIN }, { type: TerminalActionType.EXIT }],
      });
      const request = { url: 'https://auth.example/login', title: 'Login', message: 'Sign in again.' };
      harness.glyph.signIn.mockImplementation(async (_existing, _access, authorize) => {
        await authorize?.(request);
        return harness.account;
      });

      await harness.application.run();

      expect(harness.glyph.signIn).toHaveBeenCalledWith(harness.account, false, expect.any(Function));
      expect(harness.ui.authorize).toHaveBeenCalledWith(request);
      expect(harness.glyph.listModels).toHaveBeenCalledTimes(2);
    });

    it('explains an unknown command', async () => {
      const harness = createHarness({
        actions: [{ type: TerminalActionType.UNKNOWN_COMMAND }, { type: TerminalActionType.EXIT }],
      });

      await harness.application.run();

      expect(harness.ui.showUnknownCommand).toHaveBeenCalledOnce();
    });

    it('sends a prompt with its attachments and reports the completed turn', async () => {
      const harness = createHarness({
        actions: [
          { type: TerminalActionType.SEND, prompt: 'Explain this', attachmentPaths: ['src/App.tsx'] },
          { type: TerminalActionType.EXIT },
        ],
      });

      await harness.application.run();

      expect(harness.ui.beginAssistantResponse).toHaveBeenCalledOnce();
      expect(harness.glyph.resolveChatRequest).toHaveBeenCalledWith('Explain this', [{ path: 'src/App.tsx' }]);
      expect(harness.active.send).toHaveBeenCalledWith(
        { text: 'Explain this', attachments: [{ path: 'src/App.tsx' }] },
        harness.ui,
        expect.any(AbortSignal),
      );
      expect(harness.ui.showTurnCompleted).toHaveBeenCalledWith(10, null);
      expect(harness.glyph.commitReviewResults).toHaveBeenCalledTimes(3);
      expect(harness.application.active).toBeUndefined();
    });

    it('drops a prompt submitted as shutdown begins', async () => {
      const harness = createHarness();
      harness.ui.nextAction.mockImplementation(async () => {
        harness.shutdown.abort();
        return { type: TerminalActionType.SEND, prompt: 'Too late', attachmentPaths: [] };
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.beginAssistantResponse).not.toHaveBeenCalled();
      expect(harness.active.send).not.toHaveBeenCalled();
    });

    it('resumes a queued background wake in the active chat before prompting again', async () => {
      const wake = wakeEvent();
      const shells = shellSessions();
      shells.peekPendingWake.mockReturnValueOnce(wake);
      const harness = createHarness({
        actions: [{ type: TerminalActionType.EXIT }],
        shellSessions: shells as unknown as ShellSessionManager,
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.active.recordContext).toHaveBeenCalledWith([
        { schemaVersion: 1, id: 'wake-one', type: 'shell_wake', payload: wake },
      ]);
      expect(shells.takePendingWake).toHaveBeenCalledWith('wake-one');
      expect(harness.ui.showShellWake).toHaveBeenCalledWith(wake);
      expect(harness.active.send).toHaveBeenCalledWith(
        {
          text: 'A background shell wake condition matched. Continue from the shell_wake context event.',
          attachments: [],
        },
        harness.ui,
        expect.any(AbortSignal),
      );
      expect(shells.setOwnerChat).toHaveBeenCalledWith('active-chat');
      expect(harness.ui.nextAction).toHaveBeenCalledOnce();
    });

    it('does not resume a background wake that arrives as the application shuts down', async () => {
      const wake = wakeEvent();
      const shells = shellSessions();
      const harness = createHarness({ shellSessions: shells as unknown as ShellSessionManager });
      shells.peekPendingWake.mockImplementation(() => {
        harness.shutdown.abort();
        return wake;
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.active.recordContext).not.toHaveBeenCalled();
      expect(shells.takePendingWake).not.toHaveBeenCalled();
    });

    it('reports a background wake whose owning chat cannot be opened', async () => {
      const wake = wakeEvent({ ownerChatId: 'missing-chat' });
      const shells = shellSessions();
      shells.peekPendingWake.mockImplementationOnce(accepts => (accepts(wake) ? wake : undefined));
      const harness = createHarness({
        actions: [{ type: TerminalActionType.EXIT }],
        shellSessions: shells as unknown as ShellSessionManager,
      });
      harness.glyph.listChats.mockReturnValue([chatSummary('missing-chat', 'other-model')]);
      harness.glyph.openChat.mockImplementation(() => {
        throw new Error('That chat belongs to a different secret account.');
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.showError).toHaveBeenCalledWith('That chat belongs to a different [REDACTED] account.');
      expect(harness.active.recordContext).not.toHaveBeenCalled();
      expect(shells.takePendingWake).not.toHaveBeenCalled();
    });

    it('keeps the prompt open when a wake belongs to a chat outside the active account', async () => {
      const shells = shellSessions();
      const harness = createHarness({ shellSessions: shells as unknown as ShellSessionManager });
      harness.ui.nextAction.mockImplementation(async (signal: AbortSignal) => {
        for (const [listener] of shells.onDidWake.mock.calls) listener(wakeEvent({ ownerChatId: 'foreign-chat' }));
        expect(signal.aborted).toBe(false);
        return { type: TerminalActionType.EXIT };
      });

      await expect(harness.application.run()).resolves.toBe(0);

      expect(harness.ui.preservePromptDraft).not.toHaveBeenCalled();
      expect(shells.stop).toHaveBeenCalledOnce();
    });

    it('reports a prompt failure that was not caused by a background wake', async () => {
      const shells = shellSessions();
      const harness = createHarness({ shellSessions: shells as unknown as ShellSessionManager });
      harness.ui.nextAction.mockRejectedValue(new Error('Input stream failed.'));

      await expect(harness.application.run()).resolves.toBe(1);

      expect(harness.ui.showError).toHaveBeenCalledWith('Input stream failed.');
      expect(shells.stop).toHaveBeenCalledOnce();
      expect(shells.dispose).toHaveBeenCalledOnce();
    });
  });

  describe('chat selection guards', () => {
    it('refuses to continue a conversation before one is selected', () => {
      const harness = createHarness();
      const guarded = harness.application as unknown as { requireConversation(): ChatSession };

      expect(() => guarded.requireConversation()).toThrow('Select an account and model before sending a message.');
    });

    it('refuses to start a chat before a model is selected', () => {
      const harness = createHarness();
      const guarded = harness.application as unknown as { requireModel(): Model };

      expect(() => guarded.requireModel()).toThrow('Select a model before starting a chat.');
    });
  });
});

interface HarnessOptions {
  readonly actions?: readonly TerminalAction[];
  readonly account?: ChatAccount;
  readonly configuredModel?: string;
  readonly reviewer?: TerminalEditReviewer;
  readonly shellSessions?: ShellSessionManager;
}

function createHarness({
  actions = [],
  account = chatAccount(),
  configuredModel,
  reviewer,
  shellSessions: shells,
}: HarnessOptions = {}) {
  const shutdown = new AbortController();
  const active = chatSession('active-chat');
  const pendingActions = [...actions];
  const context: ProjectContext = {
    id: 'project',
    mutationIdentity: 'project-root',
    kind: ProjectContextKind.FOLDER,
    name: 'Project',
    authority: 'local',
    roots: [{ name: 'Project', path: '/project' }],
  };
  const glyph = {
    initialize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    tracePath: '/state/trace.log',
    isTraceEnabled: false,
    providerPresentation: {
      name: 'Fixture',
      welcome: 'Glyph | Fixture',
      usageDescription: 'Fixture usage',
      accountsHeading: 'Accounts',
      addAccountLabel: 'Add account',
      activeAccessLabel: 'Fixture access',
    },
    accounts: [account],
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
    proposalReviews: undefined as ReturnType<typeof proposalReviews> | undefined,
    signIn: vi.fn(
      async (existing?: ChatAccount, _access?: boolean, _authorize?: ChatAuthorizationHandler): Promise<ChatAccount> =>
        existing ?? account,
    ),
    hasInferenceAccess: vi.fn((value: ChatAccount) => value.inferenceAccess),
    acknowledgeAccountNotice: vi.fn(async (_account: ChatAccount) => {}),
    listModels: vi.fn(async (_account: ChatAccount, _signal?: AbortSignal): Promise<Model[]> => [
      { slug: 'model', name: 'Model' },
    ]),
    listChats: vi.fn((_account?: ChatAccount): readonly ChatSessionSummary[] => []),
    openChat: vi.fn((_identifier: string, _account: ChatAccount): ChatSession => active.session),
    createChat: vi.fn(async (_account: ChatAccount, _model: Model): Promise<ChatSession> => active.session),
    renameChat: vi.fn(async (identifier: string, title: string) => ({ ...chatSummary(identifier), title })),
    setTraceEnabled: vi.fn((_enabled: boolean) => {}),
    logout: vi.fn(async (_account: ChatAccount) => true),
    commitReviewResults: vi.fn(async (_destination: unknown, _options?: { signal?: AbortSignal }) => {}),
    resolveChatRequest: vi.fn(async (text: string, references: readonly { path: string }[] = []) => ({
      text,
      attachments: references,
    })),
    redact: vi.fn((value: string) => value.replaceAll('secret', '[REDACTED]')),
  };
  const ui = {
    showWelcome: vi.fn(),
    chooseAccount: vi.fn(async (accounts: readonly ChatAccount[]): Promise<AccountSelection> => ({
      type: AccountSelectionType.ACCOUNT,
      account: accounts[0]!,
    })),
    authorize: vi.fn(async () => {}),
    confirmInferenceAccess: vi.fn(async (_prompt: string, _signal: AbortSignal) => false),
    acknowledgeAccountNotice: vi.fn(async () => {}),
    chooseModel: vi.fn(async (models: readonly Model[]) => models[0]!),
    showActive: vi.fn(),
    showChatActivated: vi.fn(),
    nextAction: vi.fn(
      async (_signal: AbortSignal, _pending?: number): Promise<TerminalAction> =>
        pendingActions.shift() ?? { type: TerminalActionType.EXIT },
    ),
    showHelp: vi.fn(),
    showConversationReset: vi.fn(),
    showError: vi.fn(),
    showChats: vi.fn(),
    showChatRenamed: vi.fn(),
    showUsage: vi.fn(),
    showTrace: vi.fn(),
    showLogout: vi.fn(),
    showUnknownCommand: vi.fn(),
    beginAssistantResponse: vi.fn(),
    showTurnCompleted: vi.fn(),
    showTurnFailed: vi.fn(),
    preservePromptDraft: vi.fn(),
    showShellWake: vi.fn(),
  };
  const application = new TerminalApplication(
    glyph as unknown as GlyphService,
    ui as unknown as TerminalUI,
    shutdown.signal,
    {
      projectContext: context,
      ...(configuredModel !== undefined && configuredModel !== '' ? { configuredModel } : {}),
    },
    reviewer,
    shells,
  );
  return { shutdown, active, glyph, ui, application, account, projectContext: context };
}

function chatAccount(overrides: Partial<ChatAccount> = {}): ChatAccount {
  return {
    provider: 'fixture',
    id: 'account',
    label: 'developer@example.com',
    connected: true,
    inferenceAccess: true,
    ...overrides,
  };
}

function chatSummary(id: string, modelSlug = 'model'): ChatSessionSummary {
  return {
    schemaVersion: 3,
    id,
    title: 'Chat',
    titleOrigin: 'generated',
    projectContextId: 'project',
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug,
    modelName: 'Model',
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    turnCount: 0,
  };
}

function chatSession(id: string) {
  const reset = vi.fn(async () => {});
  const setTraceEnabled = vi.fn();
  const recordContext = vi.fn(async () => {});
  const send = vi.fn(async () => ({ responseId: 'response', durationMs: 10, usage: null }));
  const session = {
    id,
    summary: chatSummary(id),
    transcript: [],
    reset,
    setTraceEnabled,
    recordContext,
    send,
  } as unknown as ChatSession;
  return { session, reset, setTraceEnabled, recordContext, send };
}

function proposalReviews({ active = false, pendingChangeCount = 0 } = {}) {
  return {
    active,
    pendingChangeCount,
    acceptAll: vi.fn(async () => {}),
    rejectAll: vi.fn(async () => {}),
  };
}

function shellSessions() {
  const stop = vi.fn();
  return {
    stop,
    peekPendingWake: vi.fn((_accepts: (event: ShellWakeEvent) => boolean): ShellWakeEvent | undefined => undefined),
    takePendingWake: vi.fn((_id: string) => undefined as ShellWakeEvent | undefined),
    onDidWake: vi.fn((_listener: (event: ShellWakeEvent) => void) => stop),
    setOwnerChat: vi.fn((_chatId: string) => {}),
    dispose: vi.fn(async () => {}),
  };
}

function wakeEvent(overrides: Partial<ShellWakeEvent> = {}): ShellWakeEvent {
  return {
    id: 'wake-one',
    terminalId: 'terminal-one',
    pattern: 'ready',
    command: 'pnpm dev',
    workingDirectory: '/project',
    output: 'ready',
    matchedAt: '2026-10-07T00:00:00.000Z',
    ...overrides,
  };
}
