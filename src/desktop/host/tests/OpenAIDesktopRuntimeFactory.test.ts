import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';
import { testPackageMutations } from '#src/skills/tests/fixtures/testPackageMutations.js';
import type { NativeShellSandboxLauncher } from '#src/shell/NativeShellSandboxLauncher.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { GlyphMutationReceiptState } from '#src/desktop/protocol/editor/GlyphMutationReceipt.js';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphService } from '#src/application/GlyphService.js';
import { OpenAIDesktopRuntimeFactory, userRuleUri } from '#src/desktop/host/OpenAIDesktopRuntimeFactory.js';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { contentRevision } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import { EnvironmentConfigurationProvider } from '#src/configuration/EnvironmentConfigurationProvider.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { SqliteChatSessionStore } from '#src/chat/sessions/SqliteChatSessionStore.js';
import { ProjectContextIdentity } from '#src/project/context/ProjectContextIdentity.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { OpenAIBackend } from '#src/providers/openai/OpenAIBackend.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';
import OpenAI from 'openai';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionSummary } from '#src/chat/sessions/ChatSessionRecord.js';
import type { RustWorkspacePathIndexConfiguration } from '#src/context/search/RustWorkspacePathIndexOptions.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { ProviderDesktopRuntime } from '#src/desktop/host/ProviderDesktopRuntime.js';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import { GlyphFileMutationKind, type GlyphFileMutation } from '#src/desktop/protocol/editor/GlyphFileMutation.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { EditorWorkspaceClient } from '#src/desktop/workspace/EditorWorkspaceClient.js';
import type { ModeSwitchToolRuntime } from '#src/interaction/modes/ModeSwitchToolRuntime.js';
import type { PlanToolRuntime } from '#src/planning/PlanToolRuntime.js';
import { OpenAIAccountService } from '#src/providers/openai/auth/OpenAIAccountService.js';
import type { OpenAIProviderFactory } from '#src/providers/openai/OpenAIProviderFactory.js';
import type { ConversationAgentReviewExecutor } from '#src/reviewing/ConversationAgentReviewExecutor.js';
import { AgentReviewService } from '#src/reviewing/AgentReviewService.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';
import type { TodoToolRuntime } from '#src/todos/TodoToolRuntime.js';
import type { GoalToolRuntime } from '#src/goals/GoalToolRuntime.js';
import { Goal } from '#src/goals/Goal.js';
import { GoalStatus } from '#src/goals/GoalStatus.js';
import { GlyphWorkbenchCommandType as Command } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { aSkillDraft } from '#src/skills/tests/fixtures/aSkillLifecycle.js';
import { WebApprovalService } from '#src/web/WebApprovalService.js';

const captured = vi.hoisted(() => ({
  editorClients: [] as EditorWorkspaceClient[],
  sandboxOptions: [] as ConstructorParameters<typeof NativeShellSandboxLauncher>[0][],
  indexOptions: [] as RustWorkspacePathIndexConfiguration[],
  indexes: [] as RustWorkspacePathIndex[],
  modeSwitches: [] as ConstructorParameters<typeof ModeSwitchToolRuntime>[0][],
  plans: [] as ConstructorParameters<typeof PlanToolRuntime>[0][],
  todos: [] as ConstructorParameters<typeof TodoToolRuntime>[0][],
  goals: [] as ConstructorParameters<typeof GoalToolRuntime>[],
  reviewExecutors: [] as ConstructorParameters<typeof ConversationAgentReviewExecutor>[0][],
  conversations: [] as ConstructorParameters<typeof ChatConversation>[],
  brokers: [] as { readonly broker: DesktopInteractionBroker; readonly emit: (event: GlyphHostEvent) => void }[],
  providerFactories: [] as ConstructorParameters<typeof OpenAIProviderFactory>[],
}));

const openWorkspaceMutations = NativeWorkspaceMutations.open;
let isolatedUserDirectory: string;
beforeEach(async () => {
  isolatedUserDirectory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-factory-user-')));
  onTestFinished(() => rm(isolatedUserDirectory, { recursive: true, force: true }));
  vi.spyOn(NativeWorkspaceMutations, 'open').mockImplementation(async (_executable, root) => {
    // Composition uses the deterministic filesystem port below. Bind its native
    // client to this runner rather than requiring a packaged app installation.
    const instance = await openWorkspaceMutations(process.execPath, root);
    const mutations = testPackageMutations(root);
    vi.spyOn(instance, 'ensureDirectory').mockImplementation(mutations.ensureDirectory);
    vi.spyOn(instance, 'renameExclusive').mockImplementation(mutations.renameExclusive);
    vi.spyOn(instance, 'removeTree').mockImplementation(mutations.removeTree);
    vi.spyOn(instance, 'createStage').mockImplementation(mutations.createStage);
    vi.spyOn(instance, 'stagePackage').mockImplementation(mutations.stagePackage);
    return instance;
  });
  vi.spyOn(RustWorkspacePathIndex.prototype, 'glob').mockResolvedValue({ files: [], truncated: false });
});

it('resolves user rule URIs below the dedicated user rule root', () => {
  expect(userRuleUri('/home/user/.glyph', 'rules/test.mdc')).toBe('file:///home/user/.glyph/rules/test.mdc');
});

vi.mock('#src/shell/NativeShellSandboxLauncher.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/shell/NativeShellSandboxLauncher.js')>();
  return {
    ...actual,
    NativeShellSandboxLauncher: class extends actual.NativeShellSandboxLauncher {
      constructor(...args: ConstructorParameters<typeof actual.NativeShellSandboxLauncher>) {
        super(...args);
        captured.sandboxOptions.push(args[0]);
      }
    },
  };
});

vi.mock('#src/desktop/workspace/EditorWorkspaceTextStore.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/desktop/workspace/EditorWorkspaceTextStore.js')>();
  return {
    ...actual,
    EditorWorkspaceTextStore: class extends actual.EditorWorkspaceTextStore {
      constructor(...arguments_: ConstructorParameters<typeof actual.EditorWorkspaceTextStore>) {
        super(...arguments_);
        captured.editorClients.push(arguments_[2]);
      }
    },
  };
});

vi.mock('#src/context/search/RustWorkspacePathIndex.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/context/search/RustWorkspacePathIndex.js')>();
  return {
    ...actual,
    RustWorkspacePathIndex: class extends actual.RustWorkspacePathIndex {
      constructor(...arguments_: ConstructorParameters<typeof actual.RustWorkspacePathIndex>) {
        super(...arguments_);
        captured.indexOptions.push(arguments_[0]);
        captured.indexes.push(this);
      }
    },
  };
});

vi.mock('#src/interaction/modes/ModeSwitchToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/interaction/modes/ModeSwitchToolRuntime.js')>();
  return {
    ...actual,
    ModeSwitchToolRuntime: class extends actual.ModeSwitchToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.ModeSwitchToolRuntime>) {
        super(...arguments_);
        captured.modeSwitches.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/planning/PlanToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/planning/PlanToolRuntime.js')>();
  return {
    ...actual,
    PlanToolRuntime: class extends actual.PlanToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.PlanToolRuntime>) {
        super(...arguments_);
        captured.plans.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/todos/TodoToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/todos/TodoToolRuntime.js')>();
  return {
    ...actual,
    TodoToolRuntime: class extends actual.TodoToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.TodoToolRuntime>) {
        super(...arguments_);
        captured.todos.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/goals/GoalToolRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/goals/GoalToolRuntime.js')>();
  return {
    ...actual,
    GoalToolRuntime: class extends actual.GoalToolRuntime {
      constructor(...arguments_: ConstructorParameters<typeof actual.GoalToolRuntime>) {
        super(...arguments_);
        captured.goals.push(arguments_);
      }
    },
  };
});

vi.mock('#src/reviewing/ConversationAgentReviewExecutor.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/reviewing/ConversationAgentReviewExecutor.js')>();
  return {
    ...actual,
    ConversationAgentReviewExecutor: class extends actual.ConversationAgentReviewExecutor {
      constructor(...arguments_: ConstructorParameters<typeof actual.ConversationAgentReviewExecutor>) {
        super(...arguments_);
        captured.reviewExecutors.push(arguments_[0]);
      }
    },
  };
});

vi.mock('#src/chat/ChatConversation.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/chat/ChatConversation.js')>();
  return {
    ...actual,
    ChatConversation: class extends actual.ChatConversation {
      constructor(...arguments_: ConstructorParameters<typeof actual.ChatConversation>) {
        super(...arguments_);
        captured.conversations.push(arguments_);
      }
    },
  };
});

vi.mock('#src/desktop/host/DesktopInteractionBroker.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/desktop/host/DesktopInteractionBroker.js')>();
  return {
    ...actual,
    DesktopInteractionBroker: class extends actual.DesktopInteractionBroker {
      constructor(emit: (event: GlyphHostEvent) => void) {
        super(emit);
        captured.brokers.push({ broker: this, emit });
      }
    },
  };
});

vi.mock('#src/providers/openai/OpenAIProviderFactory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#src/providers/openai/OpenAIProviderFactory.js')>();
  return {
    ...actual,
    OpenAIProviderFactory: class extends actual.OpenAIProviderFactory {
      constructor(...arguments_: ConstructorParameters<typeof actual.OpenAIProviderFactory>) {
        super(...arguments_);
        captured.providerFactories.push(arguments_);
      }
    },
  };
});

describe(OpenAIDesktopRuntimeFactory, () => {
  it('loads saved chats and reviews without project access while untrusted and reconciles after trust returns', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-untrusted-history-')));
    const root = join(directory, 'workspace');
    const state = join(directory, 'state');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'original');
    vi.stubEnv('GLYPH_CONFIG_DIR', state);
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.spyOn(OpenAIBackend.prototype, 'initialize').mockResolvedValue();
    const indexing = vi.spyOn(RustWorkspacePathIndex.prototype, 'initialize').mockResolvedValue({
      root,
      fileCount: 1,
      fromCache: false,
      truncated: false,
      durationMilliseconds: 0,
    });
    const instructionGlobs = vi
      .spyOn(RustWorkspacePathIndex.prototype, 'glob')
      .mockResolvedValue({ files: [], truncated: false });
    const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
    const roots = [{ name: 'workspace', path: root }];
    const context = {
      id: ProjectContextIdentity.create(ProjectContextKind.WORKSPACE, 'file', 'profile:workspace'),
      mutationIdentity: ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, 'file', roots),
      kind: ProjectContextKind.FOLDER,
      name: 'workspace',
      authority: 'file',
      roots,
    };
    const disk = new FileSystemWorkspaceTextStore(root);
    const base = await disk.read('file.txt');
    const proposal = await new EditProposalService(
      disk,
      new JsDiffTextDiffer(),
      new EnvironmentConfigurationProvider().editing,
    ).proposeStructured({
      files: [
        {
          operation: EditOperation.UPDATE,
          path: 'file.txt',
          new_path: null,
          base_revision: base.revision,
          content: 'proposed',
          byte_order_mark: false,
          edits: [],
        },
      ],
    });
    const reviewStore = new FileProposalReviewStore(
      join(state, 'projects', ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'file', 'profile:workspace')),
      { mutationScope: context.mutationIdentity },
    );
    await reviewStore.save([proposal], context.mutationIdentity);
    const chats = new SqliteChatSessionStore(state);
    await chats.initialize(context);
    await chats.save({
      schemaVersion: 3,
      id: 'saved-chat',
      title: 'Saved chat',
      titleOrigin: 'human',
      projectContextId: context.id,
      accountProvider: 'openai',
      accountId: 'fixture',
      modelSlug: 'model',
      modelName: 'Model',
      createdAt: '2026-10-14T00:00:00Z',
      updatedAt: '2026-10-14T00:00:00Z',
      providerState: { provider: 'fixture', version: 1, data: null },
      transcript: [],
    });
    await chats.dispose();
    let trusted = true;
    const editor = new EditorRpcRouter();
    const requests = vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      const operationId =
        request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
        request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
          ? request.mutation.operationId
          : request.operationId;
      if (!trusted)
        return {
          operationId,
          ok: false,
          error: {
            code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
            message: 'Workspace is untrusted',
            retryable: false,
          },
        };
      return {
        operationId,
        ok: true,
        snapshot: {
          uri: `file://${root}/file.txt`,
          path: 'file.txt',
          text: 'original',
          byteOrderMark: false,
          contentRevision: base.revision,
          byteLength: 8,
          mode: 0o644,
          identity: base.identity,
          dirty: false,
          token: {
            workspaceGeneration: 'workspace',
            resource: `file://${root}/file.txt`,
            incarnation: 'model',
            version: 1,
          },
        },
      };
    });
    const factory = new OpenAIDesktopRuntimeFactory(editor, undefined, isolatedUserDirectory);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      for (trusted of [true, false, true]) {
        requests.mockClear();
        indexing.mockClear();
        instructionGlobs.mockClear();
        const input = {
          identity,
          roots: [{ name: 'workspace', canonicalPath: root, uri: `file://${root}` }],
          trusted,
          emit: () => {},
        };
        runtime = await factory.create(input);
        expect((await runtime.snapshot()).chats.map(chat => chat.id)).toEqual(['saved-chat']);
        expect((await runtime.snapshot()).proposals.map(value => value.id)).toEqual([proposal.id]);
        if (!trusted) await runtime.handle({ type: Command.REFRESH_CONTEXT_CATALOGS });
        expect(requests).toHaveBeenCalledTimes(trusted ? 1 : 0);
        expect(indexing).toHaveBeenCalledTimes(trusted ? 1 : 0);
        expect(instructionGlobs).toHaveBeenCalledTimes(trusted ? 16 : 0);
        await runtime.dispose();
        runtime = undefined;
      }
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['My Project', 'café'])('reopens the pre-routing checkpoint for an unchanged %s root', async name => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-compatible-root-')));
    const root = join(directory, 'workspace');
    const state = join(directory, 'state');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'original');
    vi.stubEnv('GLYPH_CONFIG_DIR', state);
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    let recoveredIds: readonly string[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      await this.proposalReviews?.initialize();
      recoveredIds = this.proposalReviews!.activeReviews.map(review => review.id);
    });
    const workspace = new FileSystemWorkspaceTextStore(root);
    const service = new EditProposalService(
      workspace,
      new JsDiffTextDiffer(),
      new EnvironmentConfigurationProvider().editing,
      new NullLogger(),
    );
    const base = await workspace.read('file.txt');
    const proposal = await service.proposeStructured({
      files: [
        {
          operation: EditOperation.UPDATE,
          path: 'file.txt',
          new_path: null,
          base_revision: base.revision,
          content: null,
          byte_order_mark: null,
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
              expected_text: 'original',
              replacement_text: 'changed',
            },
          ],
        },
      ],
    });
    const identity = ProjectContextIdentity.create(ProjectContextKind.FOLDER, 'file', 'profile:workspace');
    const scope = ProjectContextIdentity.createMutationScope(ProjectContextKind.FOLDER, 'file', [{ name, path: root }]);
    await new FileProposalReviewStore(join(state, 'projects', identity), { mutationScope: scope }).save(
      [proposal],
      scope,
    );
    const editors = new EditorRpcRouter();
    vi.spyOn(editors, 'request').mockResolvedValue({
      operationId: 'fixture',
      ok: true,
      snapshot: {
        ...base,
        contentRevision: base.revision,
        uri: `file://${root}/file.txt`,
        dirty: false,
        token: {
          workspaceGeneration: 'workspace',
          resource: `file://${root}/file.txt`,
          incarnation: 'model',
          version: 1,
        },
      },
    });
    const factory = new OpenAIDesktopRuntimeFactory(editors, undefined, isolatedUserDirectory);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots: [{ name, canonicalPath: root, uri: `file://${root}` }],
        trusted: true,
        emit: () => {},
      });
      expect(recoveredIds).toEqual([proposal.id]);
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('initializes distinct roots with duplicate display names instead of rejecting the workspace', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-routing-')));
    const roots = ['one', 'two'].map(value => ({
      name: 'app',
      canonicalPath: join(directory, value),
      uri: `file://${directory}/${value}`,
    }));
    for (const root of roots) await mkdir(root.canonicalPath);
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.spyOn(GlyphService.prototype, 'initialize').mockResolvedValue();
    const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter(), undefined, isolatedUserDirectory);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots,
        trusted: true,
        emit: () => {},
      });
      expect(runtime).toBeDefined();
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([ProjectContextKind.WORKSPACE, ProjectContextKind.FOLDER])(
    'preserves existing %s chats through two-to-one folder changes without exposing another workspace or profile',
    async legacyKind => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-chat-identity-')));
      const state = join(directory, 'state');
      const roots = ['A', 'B'].map(name => ({ name, path: join(directory, 'workspace', name) }));
      for (const root of roots) await mkdir(root.path, { recursive: true });
      vi.stubEnv('GLYPH_CONFIG_DIR', state);
      vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
      vi.spyOn(OpenAIBackend.prototype, 'initialize').mockResolvedValue();
      vi.spyOn(RustWorkspacePathIndex.prototype, 'initialize').mockResolvedValue({
        root: directory,
        fileCount: 0,
        fromCache: false,
        truncated: false,
        durationMilliseconds: 0,
      });
      const store = new SqliteChatSessionStore(state);
      const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter(), undefined, isolatedUserDirectory);
      let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
      try {
        for (const identity of [
          'profile:saved-workspace',
          'profile:other-workspace',
          'other-profile:saved-workspace',
        ]) {
          const context = {
            id: ProjectContextIdentity.create(legacyKind, 'file', identity),
            kind: legacyKind,
            mutationIdentity: ProjectContextIdentity.createMutationScope(legacyKind, 'file', roots),
            name: 'Saved workspace',
            authority: 'file',
            roots,
          };
          await store.initialize(context);
          await store.save({
            schemaVersion: 3,
            id: identity,
            title: 'Keep my conversation',
            titleOrigin: 'human',
            projectContextId: context.id,
            accountProvider: 'openai',
            accountId: 'fixture',
            modelSlug: 'model',
            modelName: 'Model',
            createdAt: '2026-10-12T00:00:00Z',
            updatedAt: '2026-10-12T00:00:00Z',
            providerState: { provider: 'fixture', version: 1, data: { history: ['preserve'] } },
            transcript: [
              {
                userText: 'Original question',
                assistantText: 'Original answer',
                reasoningSummary: '',
                attachmentPaths: [],
                createdAt: '2026-10-12T00:00:00Z',
              },
            ],
          });
        }
        await store.dispose();
        for (const count of [2, 1, 2]) {
          runtime = await factory.create({
            trusted: true,
            identity: { profileId: 'profile', workspaceId: 'saved-workspace', windowId: 'window' },
            roots: roots
              .slice(0, count)
              .map(root => ({ name: root.name, canonicalPath: root.path, uri: `file://${root.path}` })),
            emit: () => {},
          });
          expect((await runtime.snapshot()).chats.map(chat => chat.id)).toEqual(['profile:saved-workspace']);
          await runtime.dispose();
          runtime = undefined;
        }
      } finally {
        await runtime?.dispose();
        await store.dispose();
        await factory.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('reopens a saved workspace after adding a folder while preserving the original scope pending reviews', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-review-scopes-')));
    const project = join(directory, 'workspace');
    for (const name of ['A', 'B', 'C']) await mkdir(join(project, name), { recursive: true });
    await writeFile(join(project, 'A/file.txt'), 'original');
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    const services: GlyphService[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      await this.proposalReviews?.initialize();
      services.push(this);
    });
    const editor = new EditorRpcRouter();
    let text = 'original';
    let version = 1;
    vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      const before = contentRevision(text, false);
      const mutation = request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ? request.mutation : undefined;
      if (mutation) {
        text = mutation.text;
        version++;
      }
      return {
        operationId:
          request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
          request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
            ? request.mutation.operationId
            : request.operationId,
        ok: true,
        ...(mutation
          ? {
              receipt: {
                operationId: mutation.operationId,
                state: GlyphMutationReceiptState.APPLIED,
                beforeRevision: before,
                afterRevision: contentRevision(text, false),
                observedAt: new Date().toISOString(),
              },
            }
          : {}),
        snapshot: {
          uri: `file://${project}/A/file.txt`,
          path: 'A/file.txt',
          text,
          contentRevision: contentRevision(text, false),
          byteLength: Buffer.byteLength(text, 'utf8'),
          byteOrderMark: false,
          mode: 0o644,
          identity: 'fixture',
          dirty: false,
          token: {
            workspaceGeneration: 'workspace',
            resource: `file://${project}/A/file.txt`,
            incarnation: 'model',
            version,
          },
        },
      };
    });
    const factory = new OpenAIDesktopRuntimeFactory(editor, undefined, isolatedUserDirectory);
    const runtimes: Awaited<ReturnType<typeof factory.create>>[] = [];
    const open = async (names: string[]) => {
      const runtime = await factory.create({
        trusted: true,
        identity: { profileId: 'profile', workspaceId: 'saved-workspace', windowId: 'window' },
        roots: names.map(name => ({ name, canonicalPath: join(project, name), uri: `file://${project}/${name}` })),
        emit: () => {},
      });
      runtimes.push(runtime);
      return runtime;
    };
    try {
      const workspace = new FileSystemWorkspaceTextStore(project);
      const service = new EditProposalService(
        workspace,
        new JsDiffTextDiffer(),
        new EnvironmentConfigurationProvider().editing,
        new NullLogger(),
      );
      const base = await workspace.read('A/file.txt');
      const proposal = await service.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'A/file.txt',
            new_path: null,
            base_revision: base.revision,
            content: null,
            byte_order_mark: null,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
                expected_text: 'original',
                replacement_text: 'changed',
              },
            ],
          },
        ],
      });
      await open(['A', 'B']);
      await services[0]!.proposalReviews!.stage(proposal);
      await runtimes.pop()!.dispose();
      await open(['A', 'B', 'C']);
      expect(services[1]!.proposalReviews!.activeReviews).toEqual([]);
      await runtimes.pop()!.dispose();
      await open(['A', 'B']);
      expect(services[2]!.proposalReviews!.activeReviews.map(review => review.id)).toEqual([proposal.id]);
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('applies read budgets to a smaller unsaved editor buffer instead of its oversized disk version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-live-read-budget-'));
    const root = join(directory, 'workspace');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'old disk content'.repeat(100));
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.stubEnv('CONTEXT_MAX_FILE_BYTES', '32');
    const services: GlyphService[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      services.push(this);
    });
    const editor = new EditorRpcRouter();
    const request = vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      expect(request.type).toBe(GlyphEditorRequestType.READ_SNAPSHOT);
      return {
        operationId:
          request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION ||
          request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION
            ? request.mutation.operationId
            : request.operationId,
        ok: true,
        snapshot: {
          uri: 'file:///fixture/file.txt',
          path: 'file.txt',
          text: 'tiny',
          contentRevision: contentRevision('tiny', false),
          byteLength: 4,
          byteOrderMark: false,
          mode: 0o644,
          identity: 'fixture',
          dirty: true,
          token: {
            workspaceGeneration: 'workspace',
            resource: 'file:///fixture/file.txt',
            incarnation: 'model',
            version: 1,
          },
        },
      };
    });
    const factory = new OpenAIDesktopRuntimeFactory(editor, undefined, isolatedUserDirectory);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots: [{ name: 'workspace', canonicalPath: root, uri: `file://${root}` }],
        trusted: true,
        emit: () => {},
      });
      const service = services[0]!;
      await expect(service.resolveChatRequest('Read my buffer', [{ path: 'file.txt' }])).resolves.toMatchObject({
        attachments: [{ text: 'tiny', byteLength: 4 }],
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[1]).toMatchObject({ maxBytes: 32 });
      // Metadata-only validation must not turn editor RPC into a policy bypass.
      await writeFile(join(root, '.env'), 'harmless excluded fixture');
      await symlink(join(root, 'file.txt'), join(root, 'alias.txt'));
      await expect(service.resolveChatRequest('Excluded', [{ path: '.env' }])).rejects.toThrow();
      await expect(service.resolveChatRequest('Symlink', [{ path: 'alias.txt' }])).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe(OpenAIDesktopRuntimeFactory.prototype.create, () => {
    it('discloses nested and file-pattern guidance before approving removal from the owning project root', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const one = await fixture.folder('one', { 'AGENTS.md': 'First root guidance.' });
      const two = await fixture.folder('two', { 'AGENTS.md': 'Second root guidance.' });
      await mkdir(join(one, 'nested'));
      await writeFile(join(one, 'nested/AGENTS.md'), 'Other root guidance.');
      const packagePath = join(two, 'nested/.glyph/skills/example');
      await mkdir(join(packagePath, 'assets'), { recursive: true });
      await mkdir(join(two, '.glyph/rules'), { recursive: true });
      await writeFile(join(two, 'nested/AGENTS.md'), 'Nested package guidance.');
      await writeFile(
        join(two, '.glyph/rules/assets.mdc'),
        '---\nactivation: file_pattern\nglobs: ["**/*.bin"]\n---\nBinary asset guidance.',
      );
      await writeFile(join(packagePath, 'SKILL.md'), '---\nname: example\ndescription: fixture\n---\nBody');
      await writeFile(join(packagePath, 'assets/image.bin'), Buffer.from([0, 255]));
      const userPackage = join(fixture.userDirectory, 'skills/personal');
      await mkdir(join(userPackage, 'assets'), { recursive: true });
      await writeFile(join(userPackage, 'SKILL.md'), '---\nname: personal\ndescription: fixture\n---\nBody');
      await writeFile(join(userPackage, 'assets/image.bin'), Buffer.from([0, 128]));
      useFilesystemIndex();
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_who, request) => {
        if (request.type === GlyphEditorRequestType.READ_OPEN_SNAPSHOT)
          return { operationId: request.operationId, ok: true };
        if (
          request.type === GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES ||
          request.type === GlyphEditorRequestType.CHECK_USER_SKILL_WORKING_COPIES
        )
          return { operationId: request.operationId, ok: true, packageClean: true };
        if (request.type === GlyphEditorRequestType.READ_SNAPSHOT) {
          expect(request.path).toBe('two/nested/.glyph/skills/example/SKILL.md');
          const file = await new FileSystemWorkspaceTextStore(two).read(request.path.slice('two/'.length));
          return editorResponse(request, request.path, file.text);
        }
        throw new Error('Unexpected editor request for package removal.');
      });
      const events: GlyphHostEvent[] = [];
      const runtime = await fixture.create([one, two], event => {
        events.push(event);
      });
      const state = await runtime.snapshot();
      const installed = state.skills!.find(skill => skill.name === 'example')!;
      const user = state.skillTargets!.find(target => target.scope === 'user')!;
      const [, , registry, , turns] = captured.providerFactories[0]!;
      const turnId = 'project-removal';
      const turn = await turns!.beginTurn({ turnId, attachmentPaths: [] }, new AbortController().signal);
      expect(turn.initialEnvelope().sources.map(source => source.content)).toEqual([
        'First root guidance.',
        'Second root guidance.',
      ]);
      const propose = registry!.tools.find(tool => tool.namespace === 'skills' && tool.name === 'propose_change')!;
      const input = JSON.stringify({ target_id: user.id, replace_id: null, remove_id: installed.id, draft: null });
      const context = {
        turnId,
        mode: AgentModeID.AGENT,
        chat: { id: 'chat', accountProvider: 'openai', accountId: 'account' },
      };
      const broker = captured.brokers[0]!.broker;
      const execute = (currentTurn: string, change = input) =>
        broker.run({ chatId: 'chat', runId: 'run' }, () =>
          propose.execute(change, new AbortController().signal, { ...context, turnId: currentTurn }),
        );
      const denyApproval = async (currentTurn: string, change = input) => {
        const firstEvent = events.length;
        const pending = execute(currentTurn, change);
        const approval = await vi.waitFor(() => {
          const event = events.slice(firstEvent).find(value => value.type === GlyphHostEventType.APPROVAL);
          if (!event || event.type !== GlyphHostEventType.APPROVAL) throw new Error('Waiting for package approval.');
          return event.approval;
        });
        broker.answer({
          chatId: 'chat',
          runId: 'run',
          id: approval.id,
          kind: 'approval',
          value: GlyphApprovalDecision.DENY,
        });
        expect(JSON.parse(await pending)).toMatchObject({ applied: false, denied: true });
      };
      const result = await execute(turnId);
      expect(JSON.parse(result)).toMatchObject({
        status: 'INSTRUCTION_CONTEXT_REQUIRED',
        instructionContext: {
          sources: expect.arrayContaining([
            expect.objectContaining({ path: 'two/nested/AGENTS.md', content: 'Nested package guidance.' }),
            expect.objectContaining({ path: 'two/.glyph/rules/assets.mdc', content: 'Binary asset guidance.' }),
          ]),
        },
      });
      expect(result).not.toContain('root guidance.');
      expect(propose.activityPresentation?.show(result)).toBe(false);
      expect(events.some(event => event.type === GlyphHostEventType.APPROVAL)).toBe(false);
      await denyApproval(turnId);

      const attachedTurn = 'already-informed';
      const informed = await turns!.beginTurn({
        turnId: attachedTurn,
        attachmentPaths: ['two/nested/.glyph/skills/example/assets/image.bin'],
      });
      expect(informed.initialEnvelope().sources.map(source => source.content)).toEqual(
        expect.arrayContaining(['Nested package guidance.', 'Binary asset guidance.']),
      );
      await denyApproval(attachedTurn);
      turns!.discardTurn(attachedTurn);

      const userTurn = 'user-removal';
      await turns!.beginTurn({ turnId: userTurn, attachmentPaths: [] });
      const personal = state.skills!.find(skill => skill.name === 'personal')!;
      await denyApproval(
        userTurn,
        JSON.stringify({ target_id: installed.origin.id, replace_id: null, remove_id: personal.id, draft: null }),
      );
      turns!.discardTurn(userTurn);
      expect((await runtime.snapshot()).skills!.some(skill => skill.id === installed.id)).toBe(true);
      turns!.discardTurn(turnId);
    });
    it('wires isolated user and project package management, pinned activation, approvals, and shared enablement into production runtimes', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const catalogs: SkillCatalog[] = [];
      const refresh = SkillCatalog.prototype.refresh;
      vi.spyOn(SkillCatalog.prototype, 'refresh').mockImplementation(function (this: SkillCatalog, signal) {
        if (!catalogs.includes(this)) catalogs.push(this);
        return refresh.call(this, signal);
      });
      vi.spyOn(RustWorkspacePathIndex.prototype, 'refresh').mockResolvedValue({
        root: '/',
        fileCount: 0,
        fromCache: false,
        truncated: false,
        durationMilliseconds: 0,
      });
      useFilesystemIndex();
      const roots = [await fixture.folder('one'), await fixture.folder('two')];
      const events: GlyphHostEvent[] = [];
      const runtime = await fixture.create(roots, event => {
        events.push(event);
      });
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => {
        if (
          request.type === GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES ||
          request.type === GlyphEditorRequestType.CHECK_USER_SKILL_WORKING_COPIES
        )
          return { operationId: request.operationId, ok: true, packageClean: true };
        throw new Error('Only skill working-copy checks are expected');
      });
      const privatePaths = captured.sandboxOptions[0]!.privatePaths;
      if (typeof privatePaths !== 'function') throw new Error('Expected dynamic host metadata masks');
      expect(privatePaths()).toContain(fixture.userDirectory);
      const targets = (await runtime.snapshot()).skillTargets!;
      for (const [index, target] of targets.entries()) {
        const draft = aSkillDraft('Reviewed factory workflow', `workflow-${index}`);
        await runtime.handle({ type: Command.PREVIEW_SKILL, targetId: target.id, draft: draft.toJSON() });
        await runtime.handle({ type: Command.APPLY_SKILL, previewId: (await runtime.snapshot()).skillPreview!.id });
      }
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => {
        if (
          request.type === GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES ||
          request.type === GlyphEditorRequestType.CHECK_USER_SKILL_WORKING_COPIES
        )
          return { operationId: request.operationId, ok: true, packageClean: true };
        if (request.type === GlyphEditorRequestType.READ_OPEN_SNAPSHOT)
          return { operationId: request.operationId, ok: true };
        if (request.type !== GlyphEditorRequestType.READ_SNAPSHOT) throw new Error('Only read snapshots are expected');
        for (const root of roots) {
          const store = new FileSystemWorkspaceTextStore(root);
          const path = request.path.startsWith(`${basename(root)}/`)
            ? request.path.slice(basename(root).length + 1)
            : request.path;
          if (await store.exists(path)) return editorResponse(request, request.path, (await store.read(path)).text);
        }
        throw new Error('Package missing');
      });
      const skills = (await runtime.snapshot()).skills!;
      expect(skills).toHaveLength(3);
      expect(skills.map(skill => ({ status: skill.status, message: skill.message }))).toEqual(
        skills.map(() => ({ status: 'active', message: undefined })),
      );
      expect(skills.every(skill => skill.installedFrom === 'Local fixture')).toBe(true);
      const [, , toolSource, , turns] = captured.providerFactories[0]!;
      const prepared = await turns!.beginTurn(
        {
          turnId: 'skills-turn',
          attachmentPaths: [],
          skillIds: skills.map(skill => skill.id),
        },
        new AbortController().signal,
      );
      expect(prepared.snapshot().skills).toHaveLength(3);
      expect(prepared.snapshot().skills!.every(skill => skill.body === 'Reviewed factory workflow')).toBe(true);
      turns!.discardTurn('skills-turn');
      for (const skill of skills.filter(skill => skill.origin.scope === 'project')) {
        await runtime.handle({
          type: Command.PREVIEW_SKILL,
          targetId: skill.origin.id,
          replaceId: skill.id,
          draft: aSkillDraft('Updated factory workflow', skill.name).toJSON(),
        });
        await runtime.handle({ type: Command.APPLY_SKILL, previewId: (await runtime.snapshot()).skillPreview!.id });
      }
      await runtime.handle({ type: Command.REFRESH_CONTEXT_CATALOGS });

      await catalogs[0]!.refreshIndexes();
      const propose = toolSource!.tools.find(tool => tool.namespace === 'skills' && tool.name === 'propose_change')!;
      const broker = captured.brokers[0]!.broker;
      const pending = broker.run({ chatId: 'chat', runId: 'run' }, () =>
        propose.execute(
          JSON.stringify({ target_id: targets[0]!.id, replace_id: null, remove_id: skills[0]!.id, draft: null }),
          new AbortController().signal,
          {
            turnId: 'turn',
            mode: AgentModeID.AGENT,
            chat: { id: 'chat', accountProvider: 'openai', accountId: 'account' },
          },
        ),
      );
      await vi.waitFor(() => {
        expect(events.some(event => event.type === GlyphHostEventType.APPROVAL)).toBe(true);
      });
      const approval = events.find(event => event.type === GlyphHostEventType.APPROVAL)!;
      if (approval.type !== GlyphHostEventType.APPROVAL) throw new Error('Expected package approval');
      broker.answer({
        chatId: 'chat',
        runId: 'run',
        id: approval.approval.id,
        kind: 'approval',
        value: GlyphApprovalDecision.DENY,
      });
      expect(JSON.parse(await pending)).toMatchObject({ applied: false, denied: true });
      await runtime.handle({ type: Command.SET_SKILL_ENABLED, skillId: skills[0]!.id, enabled: false });
      const other = await fixture.create(roots);
      expect((await other.snapshot()).skills!.find(skill => skill.id === skills[0]!.id)?.enabled).toBe(false);
      const approvalBoundary = vi
        .spyOn(WebApprovalService.prototype, 'request')
        .mockRejectedValueOnce(new Error('Denied before network access'));
      const fetch = toolSource!.tools.find(tool => tool.namespace === 'web' && tool.name === 'web_fetch')!;
      expect(
        JSON.parse(
          await fetch.execute(JSON.stringify({ url: 'http://127.0.0.1/private' }), new AbortController().signal, {}),
        ),
      ).toMatchObject({ kind: 'web_error' });
      expect(approvalBoundary).toHaveBeenCalledOnce();
    });
    it('shares a lazy user-rule index across workspaces and disposes it with the factory', async () => {
      const fixture = await factoryFixture();
      const first = await fixture.create([await fixture.folder('one')]);
      await fixture.create([await fixture.folder('two')]);
      expect(captured.indexOptions).toHaveLength(4);
      expect(captured.indexOptions[1]).toMatchObject({
        root: join(fixture.userDirectory, 'rules'),
        respectGitIgnore: false,
      });
      const userIndex = captured.indexes[1]!;
      const stop = vi.spyOn(userIndex, 'dispose');
      await first.dispose();
      expect(stop).not.toHaveBeenCalled();
      await fixture.factory.dispose();
      expect(stop).toHaveBeenCalledOnce();
    });

    it('still releases accounts when the shared user-rule index fails to stop', async () => {
      const fixture = await factoryFixture();
      await fixture.create([await fixture.folder('workspace')]);
      vi.spyOn(captured.indexes[1]!, 'dispose').mockRejectedValueOnce(new Error('Index shutdown failed'));
      const accounts = vi.spyOn(OpenAIAccountService.prototype, 'dispose');
      await expect(fixture.factory.dispose()).rejects.toThrow('Index shutdown failed');
      expect(accounts).toHaveBeenCalledOnce();
    });

    it('retries account initialization after a failed attempt', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      const initialize = vi
        .spyOn(OpenAIAccountService.prototype, 'initialize')
        .mockRejectedValueOnce(new Error('Credential store locked'));
      await expect(fixture.create([root])).rejects.toThrow('Credential store locked');
      await expect(fixture.create([root])).resolves.toBeInstanceOf(ProviderDesktopRuntime);
      expect(initialize).toHaveBeenCalledTimes(2);
    });

    it('requires a local workspace root', async () => {
      const fixture = await factoryFixture();
      await expect(fixture.create([])).rejects.toThrow('A local workspace root is required.');
    });

    it('uses Windows executable names on Windows', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      try {
        await fixture.create([root]);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
      expect(captured.indexOptions[0]?.binaryPath).toBe(
        join(repositoryRoot, 'native', `win32-${process.arch}`, 'glyph-context-index.exe'),
      );
    });

    it('excludes packaged artifacts from a workspace root that contains them', async () => {
      const fixture = await factoryFixture();
      await fixture.create([dirname(repositoryRoot)]);
      expect(captured.indexOptions[0]?.excludedPaths).toEqual([basename(repositoryRoot)]);
    });

    it('routes single-root editor requests through filesystem policy before the editor', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace', { 'file.txt': 'disk' });
      await fixture.create([root]);
      const client = captured.editorClients[0]!;
      const request = vi
        .spyOn(fixture.editors, 'request')
        .mockImplementation(async (_identity, request) => editorResponse(request, 'reported/path.txt'));
      const exists = vi.spyOn(FileSystemWorkspaceTextStore.prototype, 'exists');
      const validate = vi.spyOn(FileSystemWorkspaceTextStore.prototype, 'validateAccess');
      const signal = new AbortController().signal;
      const read = { type: GlyphEditorRequestType.READ_SNAPSHOT, operationId: 'read', path: 'file.txt' } as const;
      await expect(client.request(read, signal)).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, read, signal);
      expect(validate).toHaveBeenLastCalledWith('file.txt');
      const occupancy = { type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'file.txt' } as const;
      await client.request(occupancy);
      expect(exists).toHaveBeenCalledExactlyOnceWith('file.txt');
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, occupancy, undefined);
      const text = {
        type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
        mutation: {
          operationId: 'text',
          path: 'file.txt',
          expectedContentRevision: 'revision',
          expectedToken: { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 },
          text: 'edited',
          byteOrderMark: false,
          undoGroupId: 'text',
        },
      } as const;
      await expect(client.request(text)).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, text, undefined);
      const rename = fileMutation({
        kind: GlyphFileMutationKind.RENAME,
        path: 'file.txt',
        target: 'renamed.txt',
        expectedContentRevision: 'revision',
        expectedToken: { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 },
      });
      await expect(client.request(rename)).resolves.toMatchObject({ snapshot: { path: 'renamed.txt' } });
      expect(validate).toHaveBeenLastCalledWith('renamed.txt');
      expect(request).toHaveBeenLastCalledWith(factoryIdentity, rename, undefined);
      const create = fileMutation({
        kind: GlyphFileMutationKind.CREATE,
        path: 'new.txt',
        text: 'new',
        byteOrderMark: false,
      });
      await expect(client.request(create)).resolves.toMatchObject({ snapshot: { path: 'new.txt' } });
      const deletion = fileMutation({
        kind: GlyphFileMutationKind.DELETE,
        path: 'file.txt',
        expectedContentRevision: 'revision',
        expectedToken: { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 },
        target: undefined,
      } as unknown as FileMutationInput);
      await expect(client.request(deletion)).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      for (const pathless of [
        { type: GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT, operationId: 'receipt' },
        { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'copies' },
      ] as const) {
        validate.mockClear();
        await expect(client.request(pathless)).resolves.toMatchObject({ snapshot: { path: 'reported/path.txt' } });
        expect(request).toHaveBeenLastCalledWith(factoryIdentity, pathless, undefined);
        expect(validate).not.toHaveBeenCalled();
      }
      request.mockResolvedValueOnce({ operationId: 'read', ok: false });
      await expect(client.request(read)).resolves.toEqual({ operationId: 'read', ok: false });
    });

    it('qualifies multi-root editor requests with the root name', async () => {
      const fixture = await factoryFixture();
      const one = await fixture.folder('one', { 'file.txt': 'one' });
      const two = await fixture.folder('two');
      await fixture.create([one, two]);
      const client = captured.editorClients[0]!;
      const request = vi
        .spyOn(fixture.editors, 'request')
        .mockImplementation(async (_identity, request) => editorResponse(request, 'one/reported.txt'));
      await expect(
        client.request({ type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'file.txt' }),
      ).resolves.toMatchObject({ snapshot: { path: 'file.txt' } });
      expect(request).toHaveBeenLastCalledWith(
        factoryIdentity,
        { type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'one/file.txt' },
        undefined,
      );
      const token = { workspaceGeneration: 'g', resource: 'file:///file.txt', incarnation: 'i', version: 1 };
      await client.request(
        fileMutation({
          kind: GlyphFileMutationKind.RENAME,
          path: 'file.txt',
          target: 'renamed.txt',
          expectedContentRevision: 'revision',
          expectedToken: token,
        }),
      );
      expect(request.mock.lastCall?.[1]).toMatchObject({
        mutation: { path: 'one/file.txt', target: 'one/renamed.txt' },
      });
      await client.request(
        fileMutation({ kind: GlyphFileMutationKind.CREATE, path: 'new.txt', text: '', byteOrderMark: false }),
      );
      expect(request.mock.lastCall?.[1]).toEqual(
        fileMutation({ kind: GlyphFileMutationKind.CREATE, path: 'one/new.txt', text: '', byteOrderMark: false }),
      );
      await client.request({
        type: GlyphEditorRequestType.APPLY_TEXT_MUTATION,
        mutation: {
          operationId: 'text',
          path: 'file.txt',
          expectedContentRevision: 'revision',
          expectedToken: token,
          text: 'edited',
          byteOrderMark: false,
          undoGroupId: 'text',
        },
      });
      expect(request.mock.lastCall?.[1]).toMatchObject({ mutation: { path: 'one/file.txt' } });
    });

    it('lists and canonicalizes editor paths through the workspace index and disk', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace', { 'file.txt': 'disk' });
      await fixture.create([root]);
      const client = captured.editorClients[0]!;
      const glob = vi
        .spyOn(RustWorkspacePathIndex.prototype, 'glob')
        .mockResolvedValue({ files: ['file.txt'], truncated: false });
      await expect(client.listPaths(10)).resolves.toEqual({ files: ['file.txt'], truncated: false });
      expect(glob).toHaveBeenLastCalledWith('**/*', { limit: 10 });
      await client.listPaths(5, '*.txt', 'src');
      expect(glob).toHaveBeenLastCalledWith('*.txt', { limit: 5, targetDirectory: 'src' });
      await expect(client.canonicalPath('file.txt')).resolves.toBe(
        await new FileSystemWorkspaceTextStore(root).canonicalPath('file.txt'),
      );
    });

    it('discovers project instructions through the native index while reading current editor text', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const root = await fixture.folder('workspace', { 'AGENTS.md': 'Disk guidance' });
      const glob = vi.spyOn(RustWorkspacePathIndex.prototype, 'glob').mockImplementation(async pattern => ({
        files: pattern === 'AGENTS.md' ? ['AGENTS.md'] : [],
        truncated: false,
      }));
      // Neither user nor project instruction discovery may use the disk listing port.
      const diskList = vi
        .spyOn(FileSystemWorkspaceTextStore.prototype, 'list')
        .mockResolvedValue({ files: [], truncated: false });
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => ({
        ...editorResponse(request, 'AGENTS.md', 'Unsaved editor guidance'),
        snapshot: { ...editorResponse(request, 'AGENTS.md', 'Unsaved editor guidance').snapshot!, dirty: true },
      }));
      const runtime = await fixture.create([root]);
      const snapshot = await runtime.snapshot();
      expect(snapshot.instructionSources).toEqual([
        expect.objectContaining({
          path: 'AGENTS.md',
          status: 'active',
          revision: contentRevision('Unsaved editor guidance', false),
        }),
      ]);
      expect(glob).toHaveBeenCalledTimes(8);
      expect(glob.mock.calls).toEqual(
        expect.arrayContaining([
          ['*.mdc', { limit: 10_000, rootFilesOnly: true }],
          ['AGENTS.md', { limit: 1, rootFilesOnly: true }],
          ['**/?*/AGENTS.md', { limit: 9_999 }],
          ['**/.glyph/rules/*.mdc', { limit: 10_000 }],
          ['**/.cursor/rules/*.mdc', { limit: 10_000 }],
        ]),
      );
      await runtime.handle({ type: Command.REFRESH_CONTEXT_CATALOGS });
      expect(glob).toHaveBeenCalledTimes(16);
      expect(diskList).not.toHaveBeenCalled();
    });

    it('routes catalog reads across roots and rejects snapshots for another file', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const first = await fixture.folder('first', { 'AGENTS.md': 'First disk' });
      const second = await fixture.folder('second', { 'AGENTS.md': 'Second disk' });
      vi.spyOn(RustWorkspacePathIndex.prototype, 'glob').mockImplementation(async pattern => ({
        files: pattern === 'AGENTS.md' ? ['AGENTS.md'] : [],
        truncated: false,
      }));
      const request = vi.spyOn(fixture.editors, 'request').mockImplementation(async (_owner, request) => {
        if (request.type !== GlyphEditorRequestType.READ_OPEN_SNAPSHOT) throw new Error('Unexpected request');
        return request.path === 'first/AGENTS.md'
          ? { ok: true, operationId: request.operationId }
          : editorResponse(request, 'wrong/file');
      });
      const runtime = await fixture.create([first, second]);
      const snapshot = await runtime.snapshot();
      expect(snapshot.instructionSources).toEqual([
        expect.objectContaining({ path: 'first/AGENTS.md', status: 'active' }),
        expect.objectContaining({
          path: 'second/AGENTS.md',
          status: 'error',
          message: expect.stringContaining('different path'),
        }),
      ]);
      expect(request.mock.calls.map(([, req]) => 'path' in req && req.path)).toEqual([
        'first/AGENTS.md',
        'second/AGENTS.md',
      ]);
    });

    it('retains mandatory and manual instruction identity when an alias becomes a second workspace route', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      useFilesystemIndex();
      const rpc = vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => {
        if (request.type !== GlyphEditorRequestType.READ_OPEN_SNAPSHOT) throw new Error('Expected a metadata query');
        return { operationId: request.operationId, ok: true };
      });
      const root = await fixture.folder('actual', { 'AGENTS.md': 'Required body' });
      await mkdir(join(root, '.glyph/rules'), { recursive: true });
      await writeFile(join(root, '.glyph/rules/manual.mdc'), '---\nactivation: manual\n---\nManual body');
      const alias = join(dirname(root), 'alias');
      await symlink(root, alias);
      const first = await (await fixture.create([root])).snapshot();
      const joined = await fixture.create([root, alias]);
      const current = await joined.snapshot();
      expect(current.instructionSources!.map(source => source.id)).toEqual(
        first.instructionSources!.map(source => source.id),
      );
      const turn = await captured.providerFactories.at(-1)![4]!.beginTurn({
        turnId: 'legacy',
        attachmentPaths: [],
        manualRuleIds: ['glyph_project_rule:.glyph/rules/manual.mdc'],
      });
      expect(turn.initialEnvelope().sources.map(source => source.content)).toEqual(['Manual body', 'Required body']);
      rpc.mockImplementation(async (_identity, request) => {
        if (request.type !== GlyphEditorRequestType.READ_OPEN_SNAPSHOT) throw new Error('Expected a metadata query');
        if (request.path.endsWith('AGENTS.md')) return editorResponse(request, request.path, request.path);
        return {
          operationId: request.operationId,
          ok: false,
          error: { code: GlyphDesktopErrorCode.INVALID_REQUEST, message: 'Editor disconnected', retryable: true },
        };
      });
      expect((await joined.snapshot()).instructionSources!.map(source => source.message)).toEqual(
        expect.arrayContaining(['Editor disconnected', expect.stringContaining('conflicting unsaved edits')]),
      );
      rpc.mockImplementation(async (_identity, request) => {
        if (request.type !== GlyphEditorRequestType.READ_OPEN_SNAPSHOT) throw new Error('Expected a metadata query');
        return { operationId: request.operationId, ok: false };
      });
      expect((await joined.snapshot()).instructionSources![0]!.message).toContain('catalog snapshot is unavailable');
    });
    it('retains a physical skill ID and offers it once through overlapping and aliased folders', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      useFilesystemIndex();
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => ({
        operationId: 'mutation' in request ? request.mutation.operationId : request.operationId,
        ok: true,
      }));
      const outer = await fixture.folder('outer');
      const inner = join(outer, 'inner');
      const directory = join(inner, '.glyph/skills/workflow');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\nname: workflow\ndescription: test workflow\n---\nWorkflow body',
      );
      const alias = join(dirname(outer), 'alias');
      await symlink(outer, alias);

      const original = (await (await fixture.create([outer])).snapshot()).skills!;
      expect(original).toMatchObject([{ name: 'workflow', scope: 'inner' }]);
      for (const folders of [
        [outer, inner, alias],
        [inner, alias, outer],
      ]) {
        const skills = (await (await fixture.create(folders)).snapshot()).skills!;
        expect(skills).toMatchObject([{ id: original[0]!.id, name: 'workflow', scope: 'inner' }]);
        const turn = await captured.providerFactories.at(-1)![4]!.beginTurn({
          turnId: 'skill-scope',
          attachmentPaths: ['alias/inner/src/file.ts'],
        });
        expect(turn.initialEnvelope().skillCandidates?.map(skill => skill.id)).toEqual([original[0]!.id]);
      }
    });
    it('refreshes and captures user and project skills through their owning indexes', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const root = await fixture.folder('workspace');
      for (const [base, path] of [
        [root, '.glyph/skills/workflow'],
        [fixture.userDirectory, 'skills/default'],
      ] as const) {
        await mkdir(join(base, path), { recursive: true });
        await writeFile(
          join(base, path, 'SKILL.md'),
          `---\nname: ${basename(path)}\ndescription: perform work\n---\nInstructions`,
        );
      }
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => ({
        operationId: 'mutation' in request ? request.mutation.operationId : request.operationId,
        ok: true,
      }));
      const observe = vi.spyOn(SkillCatalog.prototype, 'refresh');
      vi.spyOn(RustWorkspacePathIndex.prototype, 'glob').mockImplementation(async function (
        this: RustWorkspacePathIndex,
        pattern,
      ) {
        const rootPath = captured.indexOptions[captured.indexes.indexOf(this)]!.root;
        const files =
          pattern === '**/.glyph/skills/**/*'
            ? ['.glyph/skills/workflow/SKILL.md']
            : pattern === '**/*' && rootPath.endsWith('/skills')
              ? ['default/SKILL.md']
              : pattern === '**/*'
                ? ['SKILL.md']
                : [];
        return { files, truncated: false };
      });
      const refresh = vi
        .spyOn(RustWorkspacePathIndex.prototype, 'refresh')
        .mockResolvedValue({ truncated: false } as never);
      const runtime = await fixture.create([root]);
      const skills = (await runtime.snapshot()).skills!;
      expect(skills.map(s => s.name).toSorted()).toEqual(['default', 'workflow']);
      const coordinator = captured.providerFactories[0]![4]!;
      const turn = await coordinator.beginTurn(
        {
          turnId: 'select',
          attachmentPaths: [],
          skillIds: skills.map(s => s.id),
        },
        new AbortController().signal,
      );
      expect(turn.snapshot().skills).toHaveLength(2);
      expect(refresh).toHaveBeenCalledTimes(4);
      await (observe.mock.contexts[0] as SkillCatalog).refreshIndexes();
      expect(refresh).toHaveBeenCalledTimes(7);
      const second = await coordinator.beginTurn({
        turnId: 'no-signal',
        attachmentPaths: [],
        skillIds: [skills[0]!.id],
      });
      expect(second.snapshot().skills).toHaveLength(1);
      refresh.mockResolvedValueOnce({ truncated: true } as never);
      await expect(
        coordinator.beginTurn({ turnId: 'incomplete', attachmentPaths: [], skillIds: [skills[0]!.id] }),
      ).rejects.toThrow('incomplete');
    });

    it('retains mandatory and manual instruction identity when an alias becomes a second workspace route', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      useFilesystemIndex();
      vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => {
        if (request.type !== GlyphEditorRequestType.READ_OPEN_SNAPSHOT) throw new Error('Expected a metadata query');
        return { operationId: request.operationId, ok: true };
      });
      const root = await fixture.folder('actual', { 'AGENTS.md': 'Required body' });
      await mkdir(join(root, '.glyph/rules'), { recursive: true });
      await writeFile(join(root, '.glyph/rules/manual.mdc'), '---\nactivation: manual\n---\nManual body');
      const alias = join(dirname(root), 'alias');
      await symlink(root, alias);
      const first = await (await fixture.create([root])).snapshot();
      const current = await (await fixture.create([root, alias])).snapshot();
      expect(current.instructionSources!.map(source => source.id)).toEqual(
        first.instructionSources!.map(source => source.id),
      );
      const turn = await captured.providerFactories.at(-1)![4]!.beginTurn({
        turnId: 'legacy',
        attachmentPaths: [],
        manualRuleIds: ['glyph_project_rule:.glyph/rules/manual.mdc'],
      });
      expect(turn.initialEnvelope().sources.map(source => source.content)).toEqual(['Manual body', 'Required body']);
    });

    it('shares guidance and package preferences across aliases, nested roots, and root rebinds', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const outer = await fixture.folder('outer');
      const inner = join(outer, 'inner');
      await mkdir(join(inner, '.glyph/rules'), { recursive: true });
      await mkdir(join(inner, '.glyph/skills/example'), { recursive: true });
      await writeFile(join(inner, 'AGENTS.md'), 'Inner root instructions');
      await writeFile(join(inner, '.glyph/rules/selected.mdc'), 'Manual guidance');
      await writeFile(
        join(inner, '.glyph/skills/example/SKILL.md'),
        '---\nname: example\ndescription: physical package\n---\nBody',
      );
      const alias = join(outer, 'alias');
      await symlink(inner, alias);
      useFilesystemIndex();
      const rpc = vi.spyOn(fixture.editors, 'request').mockImplementation(async (_identity, request) => {
        if (request.type === GlyphEditorRequestType.READ_OPEN_SNAPSHOT)
          return { operationId: request.operationId, ok: true };
        throw new Error('Unexpected editor request');
      });
      const single = await fixture.create([inner]);
      const initial = await single.snapshot();
      const rule = initial.instructionSources!.find(source => source.kind === 'glyph_project_rule')!;
      const joined = await fixture.create([outer, inner, alias]);
      const current = await joined.snapshot();
      const skills = current.skills!;
      expect(skills.map(skill => skill.id)).toEqual([initial.skills![0]!.id]);
      expect(skills[0]?.scope).toBe('inner');
      expect(current.instructionSources!.filter(source => source.kind === 'agents_md')).toHaveLength(1);
      expect(current.instructionSources!.find(source => source.kind === 'glyph_project_rule')).toMatchObject({
        id: rule.id,
        legacyIds: expect.arrayContaining(['glyph_project_rule:.glyph/rules/selected.mdc']),
      });
      const turns = captured.providerFactories.at(-1)![4]!;
      const turn = await turns.beginTurn(
        { turnId: 'equivalent', attachmentPaths: ['outer/inner/file'], manualRuleIds: [rule.id] },
        new AbortController().signal,
      );
      expect(turn.initialEnvelope().sources.map(source => source.content)).toEqual(
        expect.arrayContaining(['Inner root instructions', 'Manual guidance']),
      );
      expect(turn.initialEnvelope().sources.some(source => source.uri || source.legacyIds)).toBe(false);
      expect(turn.initialEnvelope().skillCandidates?.map(skill => skill.id)).toEqual([skills[0]!.id]);
      expect(turns.disclosePaths('equivalent', ['alias/file'])).toBeUndefined();
      expect(
        rpc.mock.calls
          .filter(([, request]) => request.type === GlyphEditorRequestType.READ_OPEN_SNAPSHOT)
          .map(([, request]) => (request as { path: string }).path),
      ).toEqual(expect.arrayContaining(['inner/AGENTS.md', 'outer/inner/AGENTS.md', 'alias/AGENTS.md']));
      rpc.mockImplementation(async (_identity, request) => {
        if (request.type === GlyphEditorRequestType.READ_SNAPSHOT)
          return editorResponse(
            request,
            request.path,
            await readFile(join(inner, '.glyph/skills/example/SKILL.md'), 'utf8'),
          );
        if (request.type === GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES)
          return { operationId: request.operationId, ok: true, packageClean: true };
        if (request.type === GlyphEditorRequestType.READ_OPEN_SNAPSHOT)
          return { operationId: request.operationId, ok: true };
        throw new Error('Unexpected editor request');
      });
      await joined.handle({ type: Command.PREVIEW_SKILL, targetId: skills[0]!.origin.id, removeId: skills[0]!.id });
      expect(
        rpc.mock.calls.flatMap(([, req]) =>
          req.type === GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES ? [req.directoryUri] : [],
        ),
      ).toEqual(
        expect.arrayContaining([
          'file://' + join(inner, '.glyph/skills/example'),
          'file://' + join(alias, '.glyph/skills/example'),
        ]),
      );
      rpc.mockImplementation(async (_identity, req) => {
        if (req.type !== GlyphEditorRequestType.READ_OPEN_SNAPSHOT) throw new Error('Expected catalog reads');
        if (req.path.endsWith('AGENTS.md')) {
          const response = editorResponse(req, req.path, req.path);
          return { ...response, snapshot: { ...response.snapshot!, dirty: true } };
        }
        if (req.path.endsWith('.mdc'))
          return {
            operationId: req.operationId,
            ok: false,
            error: { code: GlyphDesktopErrorCode.INVALID_REQUEST, message: 'Editor disconnected', retryable: true },
          };
        return { operationId: req.operationId, ok: false };
      });
      const failed = await joined.snapshot();
      expect(failed.instructionSources!.map(source => source.message)).toEqual(
        expect.arrayContaining(['Editor disconnected', expect.stringContaining('conflicting unsaved edits')]),
      );
      expect(failed.skills![0]!.message).toContain('catalog snapshot is unavailable');
      await expect(turns.beginTurn({ turnId: 'invalid-guidance', attachmentPaths: [] })).rejects.toThrow(
        'Required root instruction',
      );
    });

    it('reports an unsafe user rules directory without querying its native index', async () => {
      const fixture = await factoryFixture();
      vi.spyOn(GlyphService.prototype, 'listChats').mockReturnValue([]);
      const glob = vi
        .spyOn(RustWorkspacePathIndex.prototype, 'glob')
        .mockResolvedValue({ files: [], truncated: false });
      vi.spyOn(FileSystemWorkspaceTextStore.prototype, 'canonicalPath').mockRejectedValue(
        new Error('Symlink directory is not allowed'),
      );
      const runtime = await fixture.create([await fixture.folder('workspace')]);
      expect((await runtime.snapshot()).instructionSources).toEqual([
        expect.objectContaining({
          kind: 'glyph_user_rule',
          status: 'error',
          message: 'Symlink directory is not allowed',
        }),
      ]);
      expect(glob).not.toHaveBeenCalledWith('*.mdc', expect.anything());
      expect(glob).toHaveBeenCalledTimes(6);
    });

    it.each([
      { names: ['workspace'], listed: ['file.txt', 'other/file.txt'], read: 'file.txt' },
      { names: ['one', 'two'], listed: ['one/file.txt', 'two/file.txt'], read: 'one/file.txt' },
    ])('reads live editor text for content search across $names', async ({ names, listed, read }) => {
      const fixture = await factoryFixture();
      const roots: string[] = [];
      for (const name of names) roots.push(await fixture.folder(name, { 'file.txt': 'disk' }));
      await fixture.create(roots);
      vi.spyOn(RustWorkspacePathIndex.prototype, 'filterPaths').mockImplementation(async paths =>
        paths.filter(path => path === 'file.txt'),
      );
      const request = vi
        .spyOn(fixture.editors, 'request')
        .mockImplementation(async (_identity, request) =>
          request.type === GlyphEditorRequestType.LIST_WORKING_COPY_PATHS
            ? { operationId: request.operationId, ok: true, workingCopyPaths: listed }
            : editorResponse(request, read, 'live'),
        );
      const signal = new AbortController().signal;
      await expect(captured.indexOptions[0]!.readContentOverrides!(signal)).resolves.toEqual({ 'file.txt': 'live' });
      expect(request).toHaveBeenLastCalledWith(
        factoryIdentity,
        expect.objectContaining({ type: GlyphEditorRequestType.READ_SNAPSHOT, path: read }),
        signal,
      );
    });

    it('publishes human-interaction events through the created runtime', async () => {
      const fixture = await factoryFixture();
      const emit = vi.fn();
      await fixture.create([await fixture.folder('workspace')], emit);
      const event = {
        type: GlyphHostEventType.QUESTION,
        chatId: 'chat',
        runId: 'run',
        question: { id: 'question', title: 'Question', prompt: 'Why?' },
      } as const;
      captured.brokers[0]!.emit(event);
      expect(emit).toHaveBeenCalledExactlyOnceWith(event);
    });

    it.each([
      { mode: AgentModeID.PLAN, decision: GlyphApprovalDecision.ALLOW_ONCE, status: GlyphModeSwapStatus.APPROVED },
      { mode: undefined, decision: GlyphApprovalDecision.DENY, status: GlyphModeSwapStatus.DENIED },
    ])(
      'asks before switching a chat from $mode and records the $status outcome',
      async ({ mode, decision, status }) => {
        const fixture = await factoryFixture();
        const emit = vi.fn<(event: GlyphHostEvent) => void>();
        await fixture.create([await fixture.folder('workspace')], emit);
        const summary = chatSummary({ mode: AgentModeID.AGENT });
        const setMode = vi.spyOn(ChatSessionManager.prototype, 'setMode').mockResolvedValue(summary);
        const finish = vi.spyOn(ProviderDesktopRuntime.prototype, 'finishModeSwap');
        const { broker } = captured.brokers[0]!;
        const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
        const decided = broker.run({ chatId: 'chat', runId: 'run' }, () =>
          captured.modeSwitches[0]!(
            AgentModeID.AGENT,
            'Build the plan',
            { chat, ...(mode !== undefined ? { mode } : {}) },
            new AbortController().signal,
          ),
        );
        const approval = emit.mock.calls
          .map(([event]) => event)
          .find(event => event.type === GlyphHostEventType.APPROVAL);
        if (approval?.type !== GlyphHostEventType.APPROVAL) throw new Error('The switch was not offered.');
        expect(approval.approval.modeSwap).toMatchObject({
          source: mode ?? AgentModeID.AGENT,
          target: AgentModeID.AGENT,
          description: 'Build the plan',
        });
        broker.answer({ chatId: 'chat', runId: 'run', id: approval.approval.id, kind: 'approval', value: decision });
        await expect(decided).resolves.toBe(decision === GlyphApprovalDecision.ALLOW_ONCE);
        expect(finish).toHaveBeenCalledExactlyOnceWith('chat', approval.approval.id, status);
        if (decision === GlyphApprovalDecision.ALLOW_ONCE) {
          expect(setMode).toHaveBeenCalledExactlyOnceWith('chat', AgentModeID.AGENT);
          expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
        } else expect(setMode).not.toHaveBeenCalled();
      },
    );

    it('saves plan updates, publishes the chat, and returns the latest plan', async () => {
      const fixture = await factoryFixture();
      const emit = vi.fn();
      await fixture.create([await fixture.folder('workspace')], emit);
      const plan = (revision: number) => ({
        id: 'plan',
        revision,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
        agents: [],
      });
      const updated = chatSummary({ plans: [plan(1), plan(2)] });
      const updatePlan = vi
        .spyOn(ChatSessionManager.prototype, 'updatePlan')
        .mockResolvedValueOnce(updated)
        .mockResolvedValueOnce(chatSummary());
      const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
      const update = {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
      };
      const signal = new AbortController().signal;
      await expect(captured.plans[0]!(chat, update, signal)).resolves.toEqual(plan(2));
      expect(updatePlan).toHaveBeenCalledWith(chat, update, signal);
      expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: updated });
      await expect(captured.plans[0]!(chat, update)).resolves.toBeUndefined();
    });

    it('binds goal tools to the live runtime and refuses execution before it is ready', async () => {
      const fixture = await factoryFixture();
      const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
      const signal = new AbortController().signal;
      fixture.initialize.mockImplementationOnce(async () => {
        const [propose, update] = captured.goals[0]!;
        expect(() => propose(chat, 'Ship', signal)).toThrow('Goals require an active desktop run.');
        expect(() => update(chat, GoalStatus.COMPLETE, signal)).toThrow('Goals require an active desktop run.');
      });
      const runtime = await fixture.create([await fixture.folder('workspace')]);
      const goal = Goal.create('goal', 'Ship', new Date()).toChatGoal();
      const propose = vi.spyOn(runtime, 'proposeGoal').mockResolvedValue(goal);
      const update = vi.spyOn(runtime, 'updateGoalFromTool').mockResolvedValue(goal);
      const [proposeTool, updateTool] = captured.goals[0]!;
      expect(() => proposeTool(chat, 'Ship')).toThrow('Goals require an active desktop run.');
      await expect(proposeTool(chat, 'Ship', signal)).resolves.toBe(goal);
      expect(propose).toHaveBeenCalledWith(chat, 'Ship', signal);
      await expect(updateTool(chat, GoalStatus.COMPLETE, signal)).resolves.toBe(goal);
      expect(update).toHaveBeenCalledWith(chat, GoalStatus.COMPLETE, signal);
    });

    it('saves todo updates, publishes the chat, and returns the resulting list', async () => {
      const fixture = await factoryFixture();
      const emit = vi.fn();
      await fixture.create([await fixture.folder('workspace')], emit);
      const todos = [{ id: 'todo', text: 'Do it', status: TodoStatus.PENDING }];
      const updated = chatSummary({ todos });
      const synced = chatSummary({ id: 'source' });
      vi.spyOn(ChatSessionManager.prototype, 'updateTodos')
        .mockResolvedValueOnce(updated)
        .mockResolvedValueOnce(chatSummary());
      vi.spyOn(ChatSessionManager.prototype, 'syncPlanBuild').mockResolvedValueOnce([synced]).mockResolvedValueOnce([]);
      const chat = { id: 'chat', accountProvider: 'openai', accountId: 'account' };
      await expect(captured.todos[0]!(chat, { items: todos, replace: true })).resolves.toEqual(todos);
      expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: updated });
      expect(emit).toHaveBeenCalledWith({ type: GlyphHostEventType.CHAT_UPDATED, chat: synced });
      await expect(captured.todos[0]!(chat, { items: [], replace: true })).resolves.toEqual([]);
    });

    it('runs agent reviews only through an available account with inference access', async () => {
      const fixture = await factoryFixture();
      await fixture.create([await fixture.folder('workspace')]);
      const reviewTools = captured.providerFactories.at(-1)![2]!.tools;
      expect(reviewTools.filter(tool => tool.namespace === 'skills').map(tool => tool.name)).toEqual([
        'activate',
        'read_resource',
      ]);
      const account = (provider: string, id: string) => ({
        provider,
        id,
        label: id,
        connected: true,
        inferenceAccess: true,
      });
      vi.spyOn(GlyphService.prototype, 'accounts', 'get').mockReturnValue([
        account('other', 'ready'),
        account('openai', 'blocked'),
        account('openai', 'ready'),
      ]);
      vi.spyOn(GlyphService.prototype, 'hasInferenceAccess').mockImplementation(value => value.id === 'ready');
      const provider = {} as ChatProvider;
      const createProvider = vi.spyOn(OpenAIBackend.prototype, 'createProvider').mockReturnValue(provider);
      const createConversation = captured.reviewExecutors[0]!;
      expect(() => createConversation({ accountProvider: 'openai', accountId: 'missing', model: 'gpt' })).toThrow(
        'The review account is unavailable.',
      );
      expect(() => createConversation({ accountProvider: 'openai', accountId: 'blocked', model: 'gpt' })).toThrow(
        'The review account is unavailable.',
      );
      const conversation = createConversation({ accountProvider: 'openai', accountId: 'ready', model: 'gpt' });
      expect(conversation).toBeInstanceOf(ChatConversation);
      expect(createProvider).toHaveBeenCalledExactlyOnceWith(account('openai', 'ready'), { slug: 'gpt', name: 'gpt' });
      const [conversationProvider, , redact, recordUsage] = captured.conversations.at(-1)!;
      expect(conversationProvider).toBe(provider);
      vi.spyOn(GlyphService.prototype, 'redact').mockReturnValue('[redacted]');
      expect(redact('secret')).toBe('[redacted]');
      expect(() => {
        recordUsage({} as Parameters<typeof recordUsage>[0]);
      }).not.toThrow();
    });

    it('stops shells when the application service fails to initialize', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      fixture.initialize.mockRejectedValueOnce(new Error('Index failed'));
      const shells = vi.spyOn(ShellSessionManager.prototype, 'dispose');
      await expect(fixture.create([root])).rejects.toThrow('Index failed');
      expect(shells).toHaveBeenCalledOnce();
    });

    it('releases every service when agent reviews fail to initialize', async () => {
      const fixture = await factoryFixture();
      const root = await fixture.folder('workspace');
      vi.spyOn(AgentReviewService.prototype, 'initialize').mockRejectedValueOnce(new Error('Review store failed'));
      const reviews = vi.spyOn(AgentReviewService.prototype, 'dispose');
      const shells = vi.spyOn(ShellSessionManager.prototype, 'dispose');
      const glyph = vi.spyOn(GlyphService.prototype, 'dispose');
      await expect(fixture.create([root])).rejects.toThrow('Review store failed');
      expect(reviews).toHaveBeenCalledOnce();
      expect(shells).toHaveBeenCalledOnce();
      expect(glyph).toHaveBeenCalledOnce();
    });

    it('sends provider traffic through an injected transport', async () => {
      const transport = vi.fn<typeof fetch>();
      const fixture = await factoryFixture({ transport });
      await fixture.create([await fixture.folder('workspace')]);
      const clients = captured.providerFactories.map(([, , , client]) => client);
      expect(clients).toHaveLength(2);
      expect(clients[0]).toBeInstanceOf(OpenAI);
      expect(clients[1]).toBe(clients[0]);
      expect(clients[0]?.baseURL).toBe(new EnvironmentConfigurationProvider().openAI.resource);
    });
  });

  it('leaves workspace-wide editor requests unqualified even when given a path', () => {
    const factory = new OpenAIDesktopRuntimeFactory(new EditorRpcRouter(), undefined, isolatedUserDirectory);
    const request: GlyphEditorRequest = { type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'copies' };

    const qualified = (
      factory as unknown as {
        withRequestPath(request: GlyphEditorRequest, path: string | undefined): GlyphEditorRequest;
      }
    ).withRequestPath(request, '/workspace/file.txt');

    expect(qualified).toBe(request);
  });
});

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const factoryIdentity: GlyphConnectionIdentity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };

function useFilesystemIndex(): void {
  vi.spyOn(RustWorkspacePathIndex.prototype, 'glob').mockImplementation(async function (
    this: RustWorkspacePathIndex,
    pattern,
    options,
  ) {
    const configuration = captured.indexOptions[captured.indexes.indexOf(this)]!;
    return new FileSystemWorkspaceTextStore(configuration.root).list(options.limit, pattern);
  });
}

async function factoryFixture(options: { readonly transport?: typeof fetch } = {}) {
  for (const values of Object.values(captured)) values.length = 0;
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-factory-')));
  vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
  vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
  const initialize = vi.spyOn(GlyphService.prototype, 'initialize').mockResolvedValue();
  const editors = new EditorRpcRouter();
  const userDirectory = join(directory, 'user');
  const factory = new OpenAIDesktopRuntimeFactory(editors, options.transport, userDirectory);
  const runtimes: ProviderDesktopRuntime[] = [];
  onTestFinished(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await factory.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    userDirectory: join(directory, 'user'),
    factory,
    editors,
    initialize,
    async folder(name: string, files: Readonly<Record<string, string>> = {}) {
      const path = join(directory, 'workspaces', name);
      await mkdir(path, { recursive: true });
      for (const [file, text] of Object.entries(files)) await writeFile(join(path, file), text);
      return path;
    },
    async create(paths: readonly string[], emit: (event: GlyphHostEvent) => void = () => {}) {
      const runtime = await factory.create({
        identity: factoryIdentity,
        roots: paths.map(path => ({ name: basename(path), canonicalPath: path, uri: `file://${path}` })),
        trusted: true,
        emit,
      });
      runtimes.push(runtime);
      return runtime;
    },
  };
}

function editorResponse(request: GlyphEditorRequest, path: string, text = 'text'): GlyphEditorResponse {
  return {
    operationId: 'mutation' in request ? request.mutation.operationId : request.operationId,
    ok: true,
    snapshot: {
      uri: `file:///${path}`,
      path,
      text,
      byteOrderMark: false,
      contentRevision: contentRevision(text, false),
      byteLength: Buffer.byteLength(text),
      mode: 0o644,
      identity: `file:///${path}`,
      dirty: false,
      token: { workspaceGeneration: 'g', resource: `file:///${path}`, incarnation: 'i', version: 1 },
    },
  };
}

type FileMutationInput = GlyphFileMutation extends infer Mutation
  ? Mutation extends unknown
    ? Omit<Mutation, 'operationId' | 'undoGroupId'>
    : never
  : never;

function fileMutation(
  mutation: FileMutationInput,
): Extract<GlyphEditorRequest, { type: GlyphEditorRequestType.APPLY_FILE_MUTATION }> {
  return {
    type: GlyphEditorRequestType.APPLY_FILE_MUTATION,
    mutation: { ...mutation, operationId: 'file', undoGroupId: 'file' },
  };
}

function chatSummary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    schemaVersion: 3,
    id: 'chat',
    title: 'Chat',
    titleOrigin: 'human',
    projectContextId: 'context',
    accountProvider: 'openai',
    accountId: 'account',
    modelSlug: 'gpt',
    modelName: 'GPT',
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    turnCount: 0,
    ...overrides,
  };
}
