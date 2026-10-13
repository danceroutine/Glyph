import { createHash } from 'node:crypto';
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
import { CompositeToolRuntime } from '#src/tools/CompositeToolRuntime.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { EditorWorkspaceTextStore } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
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

  constructor(private readonly editors: EditorRpcRouter) {}

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
      const index = new RustWorkspacePathIndex({
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
      });
      const workspace = new EditorWorkspaceTextStore(root.path, disk.caseSensitive, {
        listPaths: (limit, glob = '**/*', targetDirectory) =>
          index.glob(glob, { limit, ...(targetDirectory ? { targetDirectory } : {}) }),
        request: async (request, signal) => {
          // Reuse filesystem policy and symlink checks before granting editor access.
          const path = this.requestPath(request);
          if (path) await disk.validateAccess(path);
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
    // TODO: Merge dirty working-copy matches into indexed content search, hiding
    // disk matches for those same resources so reads and search agree.
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
    const tools = new CompositeToolRuntime([
      new ProjectToolRuntime(
        new ProjectAccess(root.path, { accessPolicy: policy }, workspace, index),
        new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
        reviews,
        logger,
      ),
      new ProposeQuestionToolRuntime(interactions),
      new ShellToolRuntime(shells),
    ]);
    const store = this.accounts.borrowStore();
    const http = new FetchHttpClient(logger);
    const backend = new OpenAIBackend(
      store,
      new OpenAISession(store, new OpenAIAuthenticationClient(configuration.openAI, http), configuration.openAI),
      new OpenAIModelCatalog(configuration.openAI, http),
      new OpenAIProviderFactory(root.path, configuration, tools),
      configuration.openAI,
    );
    const glyph = new GlyphService(
      backend,
      logger,
      { traceEnabled: configuration.traceEnabled },
      reviews,
      new ContextAttachmentService(workspace, configuration.contextAttachments),
      index,
      new ChatSessionManager(
        new SqliteChatSessionStore(configuration.stateDirectory, {
          contextMigration: { targetId: id, sourceIds: [legacyFolderId] },
        }),
        context,
      ),
    );
    try {
      await glyph.initialize();
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

  /** Pathless editor operations must not acquire an invented filesystem target. */
  private requestPath(request: GlyphEditorRequest): string | undefined {
    switch (request.type) {
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
      case GlyphEditorRequestType.READ_SNAPSHOT:
        return { ...request, path };
      case GlyphEditorRequestType.APPLY_TEXT_MUTATION:
        return { ...request, mutation: { ...request.mutation, path } };
      default:
        return request;
    }
  }

  async dispose(): Promise<void> {
    await this.initialized;
    await this.accounts.dispose();
  }
}
