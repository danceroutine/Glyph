import { WebToolRuntime } from '#src/web/WebToolRuntime.js';
import { WebHttpClient } from '#src/web/WebHttpClient.js';
import { WebFetchService } from '#src/web/WebFetchService.js';
import { DuckDuckGoSearch } from '#src/web/DuckDuckGoSearch.js';
import { AgentMode } from '#src/chat/AgentMode.js';
import { ModeSwitchToolRuntime } from '#src/interaction/modes/ModeSwitchToolRuntime.js';
import { PlanToolRuntime } from '#src/planning/PlanToolRuntime.js';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { realpath } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlyphService } from '#src/application/GlyphService.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import { SqliteChatSessionStore } from '#src/chat/sessions/SqliteChatSessionStore.js';
import { EnvironmentConfigurationProvider } from '#src/configuration/EnvironmentConfigurationProvider.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { MultiRootWorkspacePathIndex } from '#src/context/search/MultiRootWorkspacePathIndex.js';
import { ContextAttachmentService } from '#src/context/attachments/ContextAttachmentService.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { getEditingReadBudget } from '#src/editing/configuration/getEditingReadBudget.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import { FetchHttpClient } from '#src/http/FetchHttpClient.js';
import { FileLogger } from '#src/observability/FileLogger.js';
import { ProposeQuestionToolRuntime } from '#src/interaction/questions/ProposeQuestionToolRuntime.js';
import { ProjectAccess } from '#src/project/ProjectAccess.js';
import { ProjectToolRuntime } from '#src/project/ProjectToolRuntime.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { ProjectContextIdentity } from '#src/project/context/ProjectContextIdentity.js';
import { OpenAIBackend } from '#src/providers/openai/OpenAIBackend.js';
import { OpenAIModelCatalog } from '#src/providers/openai/OpenAIModelCatalog.js';
import { OpenAIProviderFactory } from '#src/providers/openai/OpenAIProviderFactory.js';
import { OpenAIAccountService } from '#src/providers/openai/auth/OpenAIAccountService.js';
import { OpenAIAuthenticationClient } from '#src/providers/openai/auth/OpenAIAuthenticationClient.js';
import { OpenAISession } from '#src/providers/openai/auth/OpenAISession.js';
import { FileOpenAIAccountStore } from '#src/providers/openai/auth/FileOpenAIAccountStore.js';
import { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { FileShellPermissionStore } from '#src/shell/FileShellPermissionStore.js';
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';
import { NativeShellSandboxLauncher } from '#src/shell/NativeShellSandboxLauncher.js';
import { assertShellRuntimePathIsolation } from '#src/shell/ShellRuntimePathPolicy.js';
import { ShellToolRuntime } from '#src/shell/ShellToolRuntime.js';
import { ToolRegistry } from '#src/tools/ToolRegistry.js';
import { TodoToolRuntime } from '#src/todos/TodoToolRuntime.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { EditorWorkspaceTextStore } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { readEditorContentOverrides } from '#src/desktop/workspace/readEditorContentOverrides.js';
import { getGlyphWorkspaceRootId } from '#src/desktop/protocol/connection/getGlyphWorkspaceRootId.js';
import type { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphDesktopWorkspaceRuntimeFactory } from './GlyphDesktopWorkspaceRuntimeFactory.ts';
import { DesktopInteractionBroker } from './DesktopInteractionBroker.ts';
import { ProviderDesktopRuntime } from './ProviderDesktopRuntime.ts';

/** Composition root for shared credentials and workspace-scoped production services. */
export class OpenAIDesktopRuntimeFactory implements GlyphDesktopWorkspaceRuntimeFactory {
  private readonly configuration = new EnvironmentConfigurationProvider();
  private readonly accounts = new OpenAIAccountService(new FileOpenAIAccountStore(this.configuration.stateDirectory));
  private initialized: Promise<void> | undefined;

  constructor(
    private readonly editors: EditorRpcRouter,
    private readonly transport?: typeof fetch,
  ) {}

  async create(input: Parameters<GlyphDesktopWorkspaceRuntimeFactory['create']>[0]): Promise<ProviderDesktopRuntime> {
    await (this.initialized ??= this.accounts.initialize().catch(error => {
      this.initialized = undefined;
      throw error;
    }));
    const configuration = this.configuration;
    const roots = await Promise.all(
      input.roots.map(async root => ({
        name: getGlyphWorkspaceRootId(root, input.roots),
        path: await realpath(root.canonicalPath),
      })),
    );
    const root = roots[0];
    if (!root) throw new Error('A local workspace root is required.');
    const kind = roots.length === 1 ? ProjectContextKind.FOLDER : ProjectContextKind.WORKSPACE;
    const authority = 'file';
    const containerIdentity = `${input.identity.profileId}:${input.identity.workspaceId}`;
    // Electron's workspace id identifies the container even when its folder
    // count changes. Root shape belongs in mutation authority, not chat identity.
    const id = ProjectContextIdentity.create(ProjectContextKind.WORKSPACE, authority, containerIdentity);
    const legacyFolderId = ProjectContextIdentity.create(ProjectContextKind.FOLDER, authority, containerIdentity);
    // Keep existing scoped reviews and shell permissions at their original paths.
    const mutationStorageId = ProjectContextIdentity.create(kind, authority, containerIdentity);
    const context = {
      id,
      mutationIdentity: ProjectContextIdentity.createMutationScope(kind, authority, roots),
      kind,
      name: input.roots[0]!.name,
      authority,
      roots,
    };
    const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const native = join(artifactRoot, 'native', `${process.platform}-${process.arch}`);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const indexExecutable = join(native, `glyph-context-index${suffix}`);
    const sandboxExecutable = join(native, `glyph-shell-sandbox${suffix}`);
    assertShellRuntimePathIsolation(
      roots.map(root => root.path),
      configuration.stateDirectory,
      configuration.traceFile,
    );
    const policy = new WorkspaceAccessPolicy();
    const logger = new FileLogger(configuration.traceFile);
    const parts = roots.map(root => {
      const excludedPaths = [configuration.stateDirectory, configuration.traceFile, artifactRoot].flatMap(target => {
        const path = relative(root.path, target);
        return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
          ? [path.split(sep).join('/')]
          : [];
      });
      const disk = new FileSystemWorkspaceTextStore(root.path, { accessPolicy: policy, excludedPaths });
      const index: RustWorkspacePathIndex = new RustWorkspacePathIndex({
        binaryPath: indexExecutable,
        root: root.path,
        cachePath: join(
          configuration.stateDirectory,
          `desktop-index-${createHash('sha256')
            .update(context.id + root.path)
            .digest('hex')}.bin`,
        ),
        accessPolicy: policy,
        excludedPaths,
        caseSensitive: disk.caseSensitive,
        readContentOverrides: signal =>
          readEditorContentOverrides(
            disk,
            index,
            (request, cancellation) => this.editors.request(input.identity, request, cancellation),
            roots.length > 1 ? `${root.name}/` : '',
            signal,
          ),
      });
      const workspace = new EditorWorkspaceTextStore(root.path, disk.caseSensitive, {
        canonicalPath: path => disk.canonicalPath(path),
        listPaths: (limit, glob = '**/*', targetDirectory) =>
          index.glob(glob, { limit, ...(targetDirectory ? { targetDirectory } : {}) }),
        request: async (request, signal) => {
          // Reuse filesystem policy and symlink checks before granting editor access.
          const path = this.requestPath(request);
          if (path) {
            if (request.type === GlyphEditorRequestType.EXISTS) await disk.exists(path);
            else await disk.validateAccess(path);
          }
          const qualified = path && roots.length > 1 ? `${root.name}/${path}` : path;
          const wire = this.withRequestPath(request, qualified);
          const response = await this.editors.request(input.identity, wire, signal);
          return response.snapshot && path ? { ...response, snapshot: { ...response.snapshot, path } } : response;
        },
      });
      return { name: root.name, workspace, index };
    });
    const workspace =
      roots.length === 1
        ? parts[0]!.workspace
        : new MultiRootWorkspaceTextStore(
            context,
            parts.map(part => ({ name: part.name, store: part.workspace })),
          );
    const index =
      roots.length === 1
        ? parts[0]!.index
        : new MultiRootWorkspacePathIndex(
            context.id,
            parts.map(part => ({ name: part.name, index: part.index })),
          );
    const reviews = new ProposalReviewManager(
      workspace,
      new FileProposalReviewStore(join(configuration.stateDirectory, 'projects', mutationStorageId), {
        mutationScope: context.mutationIdentity,
      }),
      logger,
      configuration.editing.maxActiveReviews,
      context.mutationIdentity,
      { maxReadBytes: getEditingReadBudget(configuration.editing) },
    );
    let runtime: ProviderDesktopRuntime | undefined;
    const interactions = new DesktopInteractionBroker(event => runtime?.publish(event));
    const shells = new ShellSessionManager(
      new ShellCommandAuthorizer(
        context.mutationIdentity,
        new FileShellPermissionStore(join(configuration.stateDirectory, 'projects', mutationStorageId)),
        interactions,
      ),
      new ShellWorkingDirectoryResolver(context),
      new NativeShellSandboxLauncher({
        binaryPath: sandboxExecutable,
        workspaceRoots: roots.map(root => root.path),
        stateDirectory: configuration.stateDirectory,
        protectedPaths: [artifactRoot],
        accessPolicy: policy,
      }),
    );
    const sessions = new ChatSessionManager(
      new SqliteChatSessionStore(configuration.stateDirectory, {
        contextMigration: { targetId: id, sourceIds: [legacyFolderId] },
      }),
      context,
    );
    const webHttp = new WebHttpClient(this.transport);
    const tools = new ToolRegistry(
      [
        new ModeSwitchToolRuntime((target, description, context, signal) =>
          interactions.presentModeSwitch(
            { source: context.mode ?? AgentMode.default.id, target, description },
            signal,
            async () => {
              const summary = await sessions.setMode(context.chat!.id, target);
              runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
            },
            (id, status) => runtime?.finishModeSwap(context.chat!.id, id, status),
          ),
        ),
        new PlanToolRuntime(async (chat, update, signal) => {
          const summary = await sessions.updatePlan(chat, update, signal);
          runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
          return summary.plans?.at(-1);
        }),
        new ProjectToolRuntime(
          new ProjectAccess(root.path, { accessPolicy: policy }, workspace, index),
          new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
          reviews,
          logger,
        ),
        new WebToolRuntime(new WebFetchService(webHttp), new DuckDuckGoSearch(webHttp)),
        new ProposeQuestionToolRuntime(interactions),
        new ShellToolRuntime(shells),
        new TodoToolRuntime(async (chat, update, signal) => {
          const summary = await sessions.updateTodos(chat, update, signal);
          runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
          return summary.todos ?? [];
        }),
      ].flatMap(source => source.tools),
    );
    const store = this.accounts.borrowStore();
    const http = new FetchHttpClient(logger, this.transport);
    const client = this.transport
      ? new OpenAI({
          // The provider replaces this placeholder with the account's token on every request.
          apiKey: 'injected-transport',
          baseURL: configuration.openAI.resource,
          organization: null,
          project: null,
          maxRetries: 0,
          logLevel: 'off',
          fetch: this.transport,
        })
      : undefined;
    const backend = new OpenAIBackend(
      store,
      new OpenAISession(store, new OpenAIAuthenticationClient(configuration.openAI, http), configuration.openAI),
      new OpenAIModelCatalog(configuration.openAI, http),
      new OpenAIProviderFactory(root.path, configuration, tools, client),
      configuration.openAI,
    );
    const glyph = new GlyphService(
      backend,
      logger,
      { traceEnabled: configuration.traceEnabled },
      reviews,
      new ContextAttachmentService(workspace, configuration.contextAttachments),
      index,
      sessions,
    );
    try {
      await glyph.initialize({ workspaceTrusted: input.trusted });
    } catch (error) {
      await shells.dispose();
      throw error;
    }
    runtime = new ProviderDesktopRuntime({
      glyph,
      interactions,
      shellSessions: shells,
      emit: input.emit,
      ownerWindowId: input.identity.windowId,
    });
    return runtime;
  }

  async dispose(): Promise<void> {
    await this.initialized;
    await this.accounts.dispose();
  }

  /** Pathless editor operations must not acquire an invented filesystem target. */
  private requestPath(request: GlyphEditorRequest): string | undefined {
    switch (request.type) {
      case GlyphEditorRequestType.EXISTS:
      case GlyphEditorRequestType.READ_SNAPSHOT:
        return request.path;
      case GlyphEditorRequestType.APPLY_TEXT_MUTATION:
        return request.mutation.path;
      default:
        return undefined;
    }
  }

  /** Qualify only resource-bearing requests; receipts and working-copy queries are workspace-wide. */
  private withRequestPath(request: GlyphEditorRequest, path: string | undefined): GlyphEditorRequest {
    if (path === undefined) return request;
    switch (request.type) {
      case GlyphEditorRequestType.EXISTS:
      case GlyphEditorRequestType.READ_SNAPSHOT:
        return { ...request, path };
      case GlyphEditorRequestType.APPLY_TEXT_MUTATION:
        return { ...request, mutation: { ...request.mutation, path } };
      default:
        return request;
    }
  }
}
