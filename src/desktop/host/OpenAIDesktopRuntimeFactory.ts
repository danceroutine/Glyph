import { WorkspaceRootSelections } from '#src/workspace/WorkspaceRootSelections.js';
import { DesktopAttachmentAccess } from './DesktopAttachmentAccess.ts';
import { readSourcePathAliases } from '#src/workspace/SourcePathAliases.js';
import { readDirectoryNamePolicies } from '#src/workspace/readDirectoryNamePolicies.js';
import { filesystemPolicyDirectory, workspaceCaseSensitivity } from '#src/workspace/workspaceCaseSensitivity.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import { assertUserWorkingCopiesClean } from '#src/desktop/workspace/assertUserWorkingCopiesClean.js';
import { createCatalogWorkspace } from '#src/desktop/workspace/createCatalogWorkspace.js';
import { AgentReviewService } from '#src/reviewing/AgentReviewService.js';
import { SqliteAgentReviewStore } from '#src/reviewing/SqliteAgentReviewStore.js';
import { ConversationAgentReviewExecutor } from '#src/reviewing/ConversationAgentReviewExecutor.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import { WebToolRuntime } from '#src/web/WebToolRuntime.js';
import { AuthorizedWebTransport } from '#src/web/AuthorizedWebTransport.js';
import { WebApprovalService } from '#src/web/WebApprovalService.js';
import { FileApprovalStore } from '#src/interaction/approvals/FileApprovalStore.js';
import { QuestionApprovalPresenter } from '#src/interaction/approvals/QuestionApprovalPresenter.js';
import { WebHttpClient } from '#src/web/WebHttpClient.js';
import { WebFetchService } from '#src/web/WebFetchService.js';
import { DuckDuckGoSearch } from '#src/web/DuckDuckGoSearch.js';
import { AgentMode } from '#src/chat/AgentMode.js';
import { ModeSwitchToolRuntime } from '#src/interaction/modes/ModeSwitchToolRuntime.js';
import { PlanToolRuntime } from '#src/planning/PlanToolRuntime.js';
import { GoalToolRuntime } from '#src/goals/GoalToolRuntime.js';
import { createHash, randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellWorkingDirectoryResolver } from '#src/shell/ShellWorkingDirectoryResolver.js';
import { NativeShellSandboxLauncher } from '#src/shell/NativeShellSandboxLauncher.js';
import { assertShellRuntimePathIsolation, resolveAvailableIdentity } from '#src/shell/ShellRuntimePathPolicy.js';
import { ShellToolRuntime } from '#src/shell/ShellToolRuntime.js';
import { ToolRegistry } from '#src/tools/ToolRegistry.js';
import { TodoToolRuntime } from '#src/todos/TodoToolRuntime.js';
import { GlyphHostEventType } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { NativePinnedSourceAuthority } from '#src/workspace/PinnedSourceAuthority.js';
import { WorkspaceRootAccess } from '#src/workspace/policy/WorkspaceRootAccess.js';
import { StartupUserProfile } from '#src/workspace/policy/StartupUserProfile.js';
import { WorkspaceContentAccess } from '#src/workspace/policy/WorkspaceContentAccess.js';
import { EditorWorkspaceTextStore } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { readEditorContentOverrides } from '#src/desktop/workspace/readEditorContentOverrides.js';
import { getGlyphWorkspaceRootId } from '#src/desktop/protocol/connection/getGlyphWorkspaceRootId.js';
import type { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphDesktopWorkspaceRuntimeFactory } from './GlyphDesktopWorkspaceRuntimeFactory.ts';
import { DesktopInteractionBroker } from './DesktopInteractionBroker.ts';
import { ProviderDesktopRuntime } from './ProviderDesktopRuntime.ts';
import { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { AgentsMdInstructionProvider } from '#src/instructions/AgentsMdInstructionProvider.js';
import { listInstructionFilesAcrossRoots } from '#src/instructions/listInstructionFilesAcrossRoots.js';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { AgentRuleInstructionProvider } from '#src/instructions/rules/AgentRuleInstructionProvider.js';
import { AgentInstructionSourceKind } from '#src/instructions/AgentInstructionSource.js';
import { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import { RuleToolRuntime } from '#src/instructions/rules/RuleToolRuntime.js';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { UserAgentRuleManager } from '#src/instructions/rules/UserAgentRuleManager.js';
import { UserRuleDirectory } from '#src/instructions/rules/UserRuleDirectory.js';
import { listUserRuleFiles } from '#src/instructions/rules/listUserRuleFiles.js';

/** Composition root for shared credentials and workspace-scoped production services. */
export class OpenAIDesktopRuntimeFactory implements GlyphDesktopWorkspaceRuntimeFactory {
  private readonly configuration = new EnvironmentConfigurationProvider();
  private readonly accounts = new OpenAIAccountService(new FileOpenAIAccountStore(this.configuration.stateDirectory));
  private initialized: Promise<void> | undefined;
  /** Runtimes attached to the same physical user directory share its rule index. */
  private readonly userRuleIndexes = new Map<string, RustWorkspacePathIndex>();

  private readonly profile: StartupUserProfile;

  constructor(
    private readonly editors: EditorRpcRouter,
    private readonly transport?: typeof fetch,
    userDirectory = join(homedir(), '.glyph'),
  ) {
    this.profile = new StartupUserProfile(userDirectory);
  }

  async create(input: Parameters<GlyphDesktopWorkspaceRuntimeFactory['create']>[0]): Promise<ProviderDesktopRuntime> {
    const selections = new WorkspaceRootSelections();
    try {
      return await this.createRuntime(input, selections);
    } catch (error) {
      selections[Symbol.dispose]();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.initialized;
    try {
      const results = await Promise.allSettled([...this.userRuleIndexes.values()].map(index => index.dispose()));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      this.profile.dispose();
      await this.accounts.dispose();
    }
  }

  private async createRuntime(
    input: Parameters<GlyphDesktopWorkspaceRuntimeFactory['create']>[0],
    selections: WorkspaceRootSelections,
  ): Promise<ProviderDesktopRuntime> {
    const selectedRoots = input.roots.map(root => selections.select(root.canonicalPath));
    await (this.initialized ??= this.accounts.initialize().catch(error => {
      this.initialized = undefined;
      throw error;
    }));
    const configuration = this.configuration;
    const roots = selectedRoots.map((selection, i) => ({
      name: getGlyphWorkspaceRootId(input.roots[i]!, input.roots),
      path: selection.path,
    }));
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
    const artifactRoot = resolve(import.meta.dirname, '../../..');
    const native = join(artifactRoot, 'native', `${process.platform}-${process.arch}`);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const indexExecutable = join(native, `glyph-context-index${suffix}`);
    const filesystemMetadata = new NativeFilesystemMetadata(indexExecutable);
    const sourcePathAliases = readSourcePathAliases.bind(undefined, indexExecutable);
    const sandboxExecutable = join(native, `glyph-shell-sandbox${suffix}`);
    assertShellRuntimePathIsolation(
      roots.map(workspaceRoot => workspaceRoot.path),
      configuration.stateDirectory,
      configuration.traceFile,
    );
    const privatePaths = [configuration.stateDirectory, configuration.traceFile].flatMap(path => [
      path,
      resolveAvailableIdentity(path),
    ]);
    const access = new WorkspaceContentAccess(this.profile, () => privatePaths, [
      artifactRoot,
      resolveAvailableIdentity(artifactRoot),
    ]);
    const policy = access.project;
    const logger = new FileLogger(configuration.traceFile);
    const namePolicies = await Promise.all(
      roots.map(workspaceRoot => RustWorkspacePathIndex.filesystemNamePolicy(indexExecutable, workspaceRoot.path)),
    );
    const parts = roots.map((workspaceRoot, i) => {
      const verifySelectedRoot = selectedRoots[i]!.assertCurrent;
      const bind = (content: typeof policy) =>
        new WorkspaceRootAccess(content, workspaceRoot.path, namePolicies[i]!.caseSensitive, [], verifySelectedRoot);
      const bound = bind(policy);
      const disk = new FileSystemWorkspaceTextStore(workspaceRoot.path, {
        access: bound,
        physicalAccess: filesystemMetadata,
      });
      const selectedDisk = new FileSystemWorkspaceTextStore(workspaceRoot.path, {
        access: bind(access.selectedFile),
        physicalAccess: filesystemMetadata,
      });
      const index: RustWorkspacePathIndex = new RustWorkspacePathIndex({
        binaryPath: indexExecutable,
        access: bound,
        cachePath: join(
          configuration.stateDirectory,
          `desktop-index-${createHash('sha256')
            .update(context.id + workspaceRoot.path)
            .digest('hex')}.bin`,
        ),
        readContentOverrides: signal =>
          readEditorContentOverrides(
            disk,
            index,
            (request, cancellation) => this.editors.request(input.identity, request, cancellation),
            roots.length > 1 ? `${workspaceRoot.name}/` : '',
            signal,
          ),
      });
      const editorStore = (admitted: FileSystemWorkspaceTextStore) =>
        new EditorWorkspaceTextStore(workspaceRoot.path, admitted.caseSensitive, {
          canonicalPath: path => admitted.canonicalPath(path),
          listPaths: (limit, glob = '**/*', targetDirectory, signal) =>
            index.glob(glob, {
              limit,
              ...(signal && { signal }),
              ...(targetDirectory !== undefined && targetDirectory !== '' ? { targetDirectory } : {}),
            }),
          request: async (request, signal) => {
            const operation = admitted.beginOperation();
            // Reuse filesystem policy and symlink checks before granting editor access.
            const path = this.requestPath(request);
            if (path !== undefined && path !== '') {
              if (request.type === GlyphEditorRequestType.EXISTS) await admitted.exists(path);
              else await admitted.validateAccess(path);
            }
            if (
              request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION &&
              'target' in request.mutation &&
              request.mutation.target
            ) {
              await admitted.validateAccess(request.mutation.target);
            }
            const qualified =
              path !== undefined && path !== '' && roots.length > 1 ? `${workspaceRoot.name}/${path}` : path;
            let wire = this.withRequestPath(request, qualified);
            if (
              wire.type === GlyphEditorRequestType.APPLY_FILE_MUTATION &&
              'target' in wire.mutation &&
              wire.mutation.target &&
              roots.length > 1
            )
              wire = {
                ...wire,
                mutation: { ...wire.mutation, target: `${workspaceRoot.name}/${wire.mutation.target}` },
              };
            operation.assertCurrent();
            const response = await this.editors.request(input.identity, wire, signal);
            if (path !== undefined && path !== '') {
              await admitted.validateAccess(path);
              if (
                request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION &&
                'target' in request.mutation &&
                request.mutation.target
              )
                await admitted.validateAccess(request.mutation.target);
            }
            operation.assertCurrent();
            return response.snapshot && path !== undefined && path !== ''
              ? {
                  ...response,
                  snapshot: {
                    ...response.snapshot,
                    path:
                      request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION && 'target' in request.mutation
                        ? (request.mutation.target ?? path)
                        : path,
                  },
                }
              : response;
          },
        });
      const workspace = editorStore(disk);
      const selectedFiles = editorStore(selectedDisk);
      const catalog = createCatalogWorkspace(disk, workspace, async request => {
        const path = roots.length > 1 ? `${workspaceRoot.name}/${request.path}` : request.path;
        const responses = await Promise.all(
          routes.equivalents(path).map(async route => {
            const response = await this.editors.request(input.identity, {
              ...request,
              operationId: randomUUID(),
              path: route,
              physicalUri: pathToFileURL(join(disk.root, request.path)).toString(),
              caseSensitive: disk.caseSensitive,
              namePolicy: namePolicies[i]!,
            });
            if (!response.ok) throw new Error(response.error?.message ?? 'The editor catalog snapshot is unavailable.');
            if (response.snapshot && response.snapshot.path !== route)
              throw new Error('The editor returned a catalog snapshot for a different path.');
            return response;
          }),
        );
        const dirty = responses.filter(response => response.snapshot);
        if (new Set(dirty.map(response => response.snapshot!.contentRevision)).size > 1)
          throw new Error('Workspace aliases have conflicting unsaved edits. Save or discard one working copy.');
        return dirty.length > 0
          ? { ...dirty[0]!, snapshot: { ...dirty[0]!.snapshot!, path: request.path } }
          : responses[0]!;
      });
      return { name: workspaceRoot.name, workspace, selectedFiles, selectedDisk, catalog, disk, index };
    });
    const routes = new WorkspaceSourceRoutes(
      parts.map((part, index) => ({
        name: part.name,
        path: part.disk.root,
        selectedPath: input.roots[index]!.canonicalPath,
        assertCurrent: selectedRoots[index]!.assertCurrent,
        caseSensitive: part.disk.caseSensitive,
        normalizesUnicode: namePolicies[index]!.normalizesUnicode,
        foldsUnicode: namePolicies[index]!.foldsUnicode,
        uri: pathToFileURL(input.roots[index]!.canonicalPath).href,
      })),
      readDirectoryNamePolicies.bind(undefined, indexExecutable),
    );
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
    const selectedFiles =
      parts.length === 1
        ? parts[0]!.selectedFiles
        : new MultiRootWorkspaceTextStore(
            context,
            parts.map(part => ({ name: part.name, store: part.selectedFiles })),
          );
    const userRuleRoot = this.profile.path;
    let instructionCatalog: AgentInstructionCatalog | undefined;
    let turnContexts: TurnContextCoordinator | undefined;
    let userRules: UserAgentRuleManager | undefined;
    if (input.trusted) {
      const catalogWorkspace =
        parts.length === 1
          ? parts[0]!.catalog
          : new MultiRootWorkspaceTextStore(
              context,
              parts.map(part => ({ name: part.name, store: part.catalog })),
            );
      const physicalParts = parts.filter(
        (part, partIndex) => parts.findIndex(other => other.disk.root === part.disk.root) === partIndex,
      );
      // Reuse each root's watched native index; instruction refreshes must not rescan the workspace.
      const listProjectInstructions = async (maxFiles: number, globPattern: string, signal?: AbortSignal) => {
        const listed = await listInstructionFilesAcrossRoots(
          physicalParts,
          maxFiles,
          globPattern,
          parts.length > 1,
          signal,
        );
        return { ...listed, files: routes.uniqueFiles(listed.files) };
      };
      const projectUri = (path: string) => pathToFileURL(routes.physicalPath(path)!).toString();
      const userNamePolicy = await RustWorkspacePathIndex.filesystemNamePolicy(
        indexExecutable,
        filesystemPolicyDirectory(userRuleRoot),
      ).catch(() => undefined);
      const userCaseSensitive = userNamePolicy?.caseSensitive ?? workspaceCaseSensitivity(userRuleRoot);
      const userRuleStore = new FileSystemWorkspaceTextStore(userRuleRoot, {
        access: new WorkspaceRootAccess(access.userCatalog, userRuleRoot, userCaseSensitive),
        physicalAccess: filesystemMetadata,
      });
      // A failed probe must still protect edits made through insensitive filename aliases.
      const userWorkingCopyPolicy = userNamePolicy ?? {
        caseSensitive: false,
        normalizesUnicode: true,
        foldsUnicode: true,
      };
      const projectSourceAuthority = new NativePinnedSourceAuthority(
        {
          beginSourceAccess: paths => routes.beginSourceAccess(paths),
          sourceOrigins: (paths, reservations, signal) =>
            filesystemMetadata.sourceOrigins(
              paths.map(path => routes.selectedSourcePath(path)),
              reservations,
              signal,
            ),
        },
        policy,
        input.assertTrusted,
      );
      const userSourceAuthority = new NativePinnedSourceAuthority(
        filesystemMetadata,
        access.userCatalog,
        input.assertTrusted,
      );
      let userRuleIndex = this.userRuleIndexes.get(userRuleRoot);
      if (!userRuleIndex) {
        userRuleIndex = new RustWorkspacePathIndex({
          binaryPath: indexExecutable,
          access: new WorkspaceRootAccess(access.userCatalog, join(userRuleRoot, 'rules'), userCaseSensitive),
          // User-owned rules retain their existing behavior regardless of home-directory Git ignores.
          respectGitIgnore: false,
        });
        this.userRuleIndexes.set(userRuleRoot, userRuleIndex);
      }
      const paths = new InstructionPaths(
        parts.length === 1 ? workspace.caseSensitive : new Map(parts.map(part => [part.name, part.disk.caseSensitive])),
        routes,
      );
      const userRuleDirectory = new UserRuleDirectory(
        userRuleRoot,
        userRuleStore.caseSensitive,
        roots,
        paths,
        sourcePathAliases,
      );
      const listProjectRules = async (maxFiles: number, pattern: string, signal?: AbortSignal) => {
        const listed = await listProjectInstructions(maxFiles, pattern, signal);
        return { ...listed, files: listed.files.filter(path => !userRuleDirectory.ownsProjectRule(path)) };
      };
      instructionCatalog = new AgentInstructionCatalog(
        [
          new AgentRuleInstructionProvider(
            userRuleStore,
            {
              authority: userSourceAuthority,
              kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
              directory: '.',
              displayPrefix: '~/.glyph/',
              projectAlias: path => userRuleDirectory.projectAlias(path),
              uriForPath: userRuleUri.bind(undefined, userRuleRoot),
            },
            async (maxFiles, _pattern, signal) => {
              // The index root must obey the store's no-symlink rule too, not just its children.
              this.profile.ensureDirectory();
              return this.profile.access(async () => {
                await userRuleStore.canonicalPath('rules');
                await mkdir(join(userRuleRoot, 'rules'), { recursive: true, mode: 0o700 });
                return listUserRuleFiles(userRuleIndex, maxFiles, signal);
              });
            },
          ),
          new AgentsMdInstructionProvider(
            catalogWorkspace,
            { paths, authority: projectSourceAuthority, uriForPath: projectUri },
            listProjectInstructions,
          ),
          new AgentRuleInstructionProvider(
            catalogWorkspace,
            {
              authority: projectSourceAuthority,
              kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
              directory: '.glyph',
              paths,
              uriForPath: projectUri,
            },
            listProjectRules,
          ),
          new AgentRuleInstructionProvider(
            catalogWorkspace,
            {
              authority: projectSourceAuthority,
              kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
              directory: '.cursor',
              paths,
              uriForPath: projectUri,
            },
            listProjectRules,
          ),
        ],
        paths,
        () => {
          userRuleDirectory.refresh();
        },
      );
      turnContexts = new TurnContextCoordinator(instructionCatalog);
      userRules = new UserAgentRuleManager(
        userRuleStore,
        instructionCatalog,
        userRuleIndex,
        filesystemMetadata,
        filename =>
          assertUserWorkingCopiesClean(
            this.editors,
            input.identity,
            'rule',
            filename,
            userWorkingCopyPolicy,
            join(userRuleRoot, 'rules', filename),
            this.profile.path,
          ),
        () => {
          this.profile.ensureDirectory();
        },
      );
    }
    const reviews = new ProposalReviewManager(
      workspace,
      new FileProposalReviewStore(join(configuration.stateDirectory, 'projects', mutationStorageId), {
        mutationScope: context.mutationIdentity,
      }),
      logger,
      configuration.editing.maxActiveReviews,
      context.mutationIdentity,
      { maxReadBytes: getEditingReadBudget(configuration.editing), autoApply: true },
    );
    let runtime: ProviderDesktopRuntime | undefined;
    const interactions = new DesktopInteractionBroker(event => runtime?.publish(event), {
      workspaceId: context.id,
      mutationScope: context.mutationIdentity,
    });
    const shells = new ShellSessionManager(
      new ShellCommandAuthorizer(
        { workspaceId: context.id, mutationScope: context.mutationIdentity },
        new FileApprovalStore(join(configuration.stateDirectory, 'projects', mutationStorageId)),
        interactions,
      ),
      new ShellWorkingDirectoryResolver(context),
      new NativeShellSandboxLauncher({
        binaryPath: sandboxExecutable,
        verifyWorkspaceRoot: selections.assertCurrent.bind(selections),
        workspaceRoots: roots.map(workspaceRoot => workspaceRoot.path),
        stateDirectory: configuration.stateDirectory,
        protectedPaths: [artifactRoot],
        accessPolicy: access.shell,
      }),
    );
    const sessions = new ChatSessionManager(
      new SqliteChatSessionStore(configuration.stateDirectory, {
        contextMigration: { targetId: id, sourceIds: [legacyFolderId] },
      }),
      context,
    );
    const webApproval = new WebApprovalService(
      { workspaceId: context.id, mutationScope: context.mutationIdentity },
      new FileApprovalStore(join(configuration.stateDirectory, 'projects', mutationStorageId)),
      new QuestionApprovalPresenter(interactions),
    );
    // The explicitly injected scripted transport owns fixture routing. Normal
    // production traffic always resolves, authorizes and pins its destination.
    const webHttp = new WebHttpClient(
      this.transport ?? new AuthorizedWebTransport((destination, signal) => webApproval.request(destination, signal)),
    );
    const tools = new ToolRegistry(
      [
        new ModeSwitchToolRuntime((target, description, toolContext, signal) =>
          interactions.presentModeSwitch(
            { source: toolContext.mode ?? AgentMode.default.id, target, description },
            signal,
            async () => {
              const summary = await sessions.setMode(toolContext.chat!.id, target);
              runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
            },
            (swapId, status) => runtime?.finishModeSwap(toolContext.chat!.id, swapId, status),
          ),
        ),
        new PlanToolRuntime(async (chat, update, signal) => {
          const summary = await sessions.updatePlan(chat, update, signal);
          runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
          return summary.plans?.at(-1);
        }),
        new ProjectToolRuntime(
          new ProjectAccess(workspace, index, {}, turnContexts),
          new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
          reviews,
          logger,
          turnContexts,
        ),
        ...(turnContexts ? [new RuleToolRuntime(turnContexts)] : []),
        new WebToolRuntime(new WebFetchService(webHttp), new DuckDuckGoSearch(webHttp)),
        new ProposeQuestionToolRuntime(interactions),
        new ShellToolRuntime(shells),
        new TodoToolRuntime(async (chat, update, signal) => {
          const summary = await sessions.updateTodos(chat, update, signal);
          runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: summary });
          for (const plan of await sessions.syncPlanBuild(chat.id))
            runtime?.publish({ type: GlyphHostEventType.CHAT_UPDATED, chat: plan });
          return summary.todos ?? [];
        }),
        new GoalToolRuntime(
          (chat, objective, signal) => {
            if (!runtime || !signal) throw new Error('Goals require an active desktop run.');
            return runtime.proposeGoal(chat, objective, signal);
          },
          (chat, status, signal) => {
            if (!runtime) throw new Error('Goals require an active desktop run.');
            return runtime.updateGoalFromTool(chat, status, signal);
          },
        ),
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
    const authentication = new OpenAISession(
      store,
      new OpenAIAuthenticationClient(configuration.openAI, http),
      configuration.openAI,
    );
    const catalog = new OpenAIModelCatalog(configuration.openAI, http);
    const backend = new OpenAIBackend(
      store,
      authentication,
      catalog,
      new OpenAIProviderFactory(configuration, tools, client, turnContexts),
      configuration.openAI,
    );
    const glyph = new GlyphService(
      backend,
      logger,
      { traceEnabled: configuration.traceEnabled },
      reviews,
      new ContextAttachmentService(selectedFiles, configuration.contextAttachments),
      index,
      sessions,
    );
    try {
      await glyph.initialize({ workspaceTrusted: input.trusted });
    } catch (error) {
      await shells.dispose();
      throw error;
    }
    // Share the account lifetime, but expose only project read/search tools to
    // reviews. No shell, proposal, mode-switch, or interactive tools are registered.
    const reviewProjectAccess = new ProjectAccess(workspace, index, {}, turnContexts);
    const reviewTools = turnContexts
      ? new ToolRegistry([...reviewProjectAccess.tools, ...new RuleToolRuntime(turnContexts).tools])
      : reviewProjectAccess;
    const reviewBackend = new OpenAIBackend(
      store,
      authentication,
      catalog,
      new OpenAIProviderFactory(configuration, reviewTools, client, turnContexts),
      configuration.openAI,
    );
    const agentReviews = new AgentReviewService(
      new SqliteAgentReviewStore(
        join(configuration.stateDirectory, 'projects', mutationStorageId, 'agent-reviews.sqlite'),
      ),
      new ConversationAgentReviewExecutor(selection => {
        const account = glyph.accounts.find(
          account => account.provider === selection.accountProvider && account.id === selection.accountId,
        );
        if (!account || !glyph.hasInferenceAccess(account)) throw new Error('The review account is unavailable.');
        return new ChatConversation(
          reviewBackend.createProvider(account, { slug: selection.model, name: selection.model }),
          logger,
          value => glyph.redact(value),
          () => {},
          configuration.traceEnabled,
        );
      }),
    );
    try {
      await agentReviews.initialize();
    } catch (error) {
      await agentReviews.dispose();
      await shells.dispose();
      await glyph.dispose();
      throw error;
    }
    runtime = new ProviderDesktopRuntime({
      releaseWorkspace: () => {
        selections[Symbol.dispose]();
      },
      glyph,
      attachmentAccess: new DesktopAttachmentAccess(routes, parts, () => {
        const project = access.project.beginOperation();
        const selected = access.selectedFile.beginOperation();
        return () => {
          project.assertCurrent();
          selected.assertCurrent();
        };
      }),
      agentReviews,
      interactions,
      shellSessions: shells,
      ...(instructionCatalog
        ? { instructionCatalog, referenceResources: (path: string) => routes.referenceResources(path) }
        : {}),
      refreshCatalogs: async signal => {
        await instructionCatalog?.refresh(signal);
      },
      instructionWatchRoots: userRules ? [userRules.directoryUri] : [],
      ...(userRules ? { userRules } : {}),
      emit: input.emit,
      ownerWindowId: input.identity.windowId,
      trusted: input.trusted,
    });
    return runtime;
  }

  /** Pathless editor operations must not acquire an invented filesystem target. */
  private requestPath(request: GlyphEditorRequest): string | undefined {
    switch (request.type) {
      case GlyphEditorRequestType.EXISTS:
      case GlyphEditorRequestType.READ_SNAPSHOT:
        return request.path;
      case GlyphEditorRequestType.APPLY_FILE_MUTATION:
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
      case GlyphEditorRequestType.APPLY_FILE_MUTATION:
        return { ...request, mutation: { ...request.mutation, path } };
      case GlyphEditorRequestType.APPLY_TEXT_MUTATION:
        return { ...request, mutation: { ...request.mutation, path } };
      default:
        return request;
    }
  }
}

/** Resolve one user-rule path without granting the rule provider broader filesystem authority. */
export function userRuleUri(root: string, path: string): string {
  return pathToFileURL(join(root, path)).toString();
}
