import { UserSkillDirectory } from '#src/skills/UserSkillDirectory.js';
import { ProjectSkillIdentity } from '#src/skills/ProjectSkillIdentity.js';
import { projectIntersection, WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';
import { filesystemPolicyDirectory, workspaceCaseSensitivity } from '#src/workspace/workspaceCaseSensitivity.js';
import { assertUserWorkingCopiesClean } from '#src/desktop/workspace/assertUserWorkingCopiesClean.js';
import { createCatalogWorkspace } from '#src/desktop/workspace/createCatalogWorkspace.js';
import { SkillProjectMutationPolicy } from '#src/skills/SkillProjectMutationPolicy.js';
import { existsSync } from 'node:fs';
import { assertSkillPackageClean } from '#src/desktop/workspace/assertSkillPackageClean.js';
import { listSkillPackageFiles } from '#src/skills/listSkillPackageFiles.js';
import { SkillScriptRunner } from '#src/skills/SkillScriptRunner.js';
import { SkillLifecycleToolRuntime } from '#src/skills/SkillLifecycleToolRuntime.js';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { SkillPackageSourceReader } from '#src/skills/SkillPackageSource.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { SkillContextContributor } from '#src/skills/SkillContextContributor.js';
import { SkillToolRuntime } from '#src/skills/SkillToolRuntime.js';
import { InstructionContextContributor } from '#src/context/turns/InstructionContextContributor.js';
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
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
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
import { listUserRuleFiles } from '#src/instructions/rules/listUserRuleFiles.js';

/** Composition root for shared credentials and workspace-scoped production services. */
export class OpenAIDesktopRuntimeFactory implements GlyphDesktopWorkspaceRuntimeFactory {
  private readonly configuration = new EnvironmentConfigurationProvider();
  private readonly accounts = new OpenAIAccountService(new FileOpenAIAccountStore(this.configuration.stateDirectory));
  private initialized: Promise<void> | undefined;
  /** User rules are shared across workspaces; the factory owns this lazy index's lifetime. */
  private skillState: SkillStateStore | undefined;
  private userSkillIndex: RustWorkspacePathIndex | undefined;
  private userRuleIndex: RustWorkspacePathIndex | undefined;

  constructor(
    private readonly editors: EditorRpcRouter,
    private readonly transport?: typeof fetch,
    private readonly userDirectory = join(homedir(), '.glyph'),
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
    const artifactRoot = resolve(import.meta.dirname, '../../..');
    const native = join(artifactRoot, 'native', `${process.platform}-${process.arch}`);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const indexExecutable = join(native, `glyph-context-index${suffix}`);
    const filesystemMetadata = new NativeFilesystemMetadata(indexExecutable);
    const sandboxExecutable = join(native, `glyph-shell-sandbox${suffix}`);
    const workspaceMutationsExecutable = join(native, `glyph-workspace-mutations${suffix}`);
    assertShellRuntimePathIsolation(
      roots.map(workspaceRoot => workspaceRoot.path),
      configuration.stateDirectory,
      configuration.traceFile,
    );
    const canonicalUserDirectory = resolveAvailableIdentity(this.userDirectory);
    const policy = new WorkspaceAccessPolicy({}, [join(canonicalUserDirectory, 'skill-state.json')]);
    const logger = new FileLogger(configuration.traceFile);
    const casing = await Promise.all(
      roots.map(workspaceRoot => RustWorkspacePathIndex.filesystemCaseSensitive(indexExecutable, workspaceRoot.path)),
    );
    const parts = roots.map((workspaceRoot, i) => {
      const excludedPaths = [configuration.stateDirectory, configuration.traceFile, artifactRoot].flatMap(target => {
        const path = relative(workspaceRoot.path, target);
        return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
          ? [path.split(sep).join('/')]
          : [];
      });
      const disk = new FileSystemWorkspaceTextStore(workspaceRoot.path, {
        caseSensitive: casing[i]!,
        accessPolicy: policy,
        excludedPaths,
      });
      const index: RustWorkspacePathIndex = new RustWorkspacePathIndex({
        binaryPath: indexExecutable,
        root: workspaceRoot.path,
        cachePath: join(
          configuration.stateDirectory,
          `desktop-index-${createHash('sha256')
            .update(context.id + workspaceRoot.path)
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
            roots.length > 1 ? `${workspaceRoot.name}/` : '',
            signal,
          ),
      });
      const workspace = new EditorWorkspaceTextStore(workspaceRoot.path, disk.caseSensitive, {
        canonicalPath: path => disk.canonicalPath(path),
        listPaths: (limit, glob = '**/*', targetDirectory) =>
          index.glob(glob, {
            limit,
            ...(targetDirectory !== undefined && targetDirectory !== '' ? { targetDirectory } : {}),
          }),
        request: async (request, signal) => {
          // Reuse filesystem policy and symlink checks before granting editor access.
          const path = this.requestPath(request);
          if (path !== undefined && path !== '') {
            if (request.type === GlyphEditorRequestType.EXISTS) await disk.exists(path);
            else await disk.validateAccess(path);
          }
          if (
            request.type === GlyphEditorRequestType.APPLY_FILE_MUTATION &&
            'target' in request.mutation &&
            request.mutation.target
          ) {
            await disk.validateAccess(request.mutation.target);
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
            wire = { ...wire, mutation: { ...wire.mutation, target: `${workspaceRoot.name}/${wire.mutation.target}` } };
          const response = await this.editors.request(input.identity, wire, signal);
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
      return { name: workspaceRoot.name, workspace, catalog, disk, index };
    });
    const routes = new WorkspaceSourceRoutes(
      parts.map((part, index) => ({
        name: part.name,
        path: part.disk.root,
        caseSensitive: part.disk.caseSensitive,
        uri: input.roots[index]!.uri,
      })),
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
    let skills: SkillCatalog | undefined;
    let skillManager: SkillPackageManager | undefined;
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
      const listProjectInstructions = async (maxFiles: number, globPattern: string) => {
        const listed = await listInstructionFilesAcrossRoots(physicalParts, maxFiles, globPattern, parts.length > 1);
        return { ...listed, files: routes.uniqueFiles(listed.files) };
      };
      const projectUri = (path: string) => pathToFileURL(routes.physicalPath(path)!).toString();
      const userRuleRoot = canonicalUserDirectory;
      const userRuleStore = new FileSystemWorkspaceTextStore(userRuleRoot, {
        caseSensitive: await RustWorkspacePathIndex.filesystemCaseSensitive(
          indexExecutable,
          filesystemPolicyDirectory(userRuleRoot),
        ).catch(() => workspaceCaseSensitivity(userRuleRoot)),
      });
      const mutationRoots = new Map(
        await Promise.all(
          [...new Set(parts.map(part => part.disk.root))].map(
            async physicalRoot =>
              [physicalRoot, await NativeWorkspaceMutations.open(workspaceMutationsExecutable, physicalRoot)] as const,
          ),
        ),
      );

      // Agent-facing sources cannot acquire the host's preference and credential authority.
      const userInstructionPolicy = new WorkspaceAccessPolicy(
        {},
        [
          configuration.stateDirectory,
          configuration.traceFile,
          artifactRoot,
          join(userRuleRoot, 'skill-state.json'),
        ].map(resolveAvailableIdentity),
      );
      const userInstructionStore = new FileSystemWorkspaceTextStore(userRuleRoot, {
        accessPolicy: userInstructionPolicy,
        caseSensitive: userRuleStore.caseSensitive,
      });
      const userRuleIndex = (this.userRuleIndex ??= new RustWorkspacePathIndex({
        binaryPath: indexExecutable,
        root: join(userRuleRoot, 'rules'),
        caseSensitive: userRuleStore.caseSensitive,
        accessPolicy: userInstructionPolicy,
        // User-owned rules retain their existing behavior regardless of home-directory Git ignores.
        respectGitIgnore: false,
      }));
      const paths = new InstructionPaths(
        parts.length === 1 ? workspace.caseSensitive : new Map(parts.map(part => [part.name, part.disk.caseSensitive])),
        routes,
      );
      instructionCatalog = new AgentInstructionCatalog(
        [
          new AgentRuleInstructionProvider(
            userInstructionStore,
            {
              kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
              directory: '.',
              displayPrefix: '~/.glyph/',
              uriForPath: userRuleUri.bind(undefined, userRuleRoot),
            },
            async maxFiles => {
              // The index root must obey the store's no-symlink rule too, not just its children.
              await mkdir(join(userRuleRoot, 'rules'), { recursive: true });
              await userInstructionStore.canonicalPath('rules');
              return listUserRuleFiles(userRuleIndex, maxFiles);
            },
          ),
          new AgentsMdInstructionProvider(catalogWorkspace, { paths, uriForPath: projectUri }, listProjectInstructions),
          new AgentRuleInstructionProvider(
            catalogWorkspace,
            { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph', paths, uriForPath: projectUri },
            listProjectInstructions,
          ),
          new AgentRuleInstructionProvider(
            catalogWorkspace,
            {
              kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
              directory: '.cursor',
              paths,
              uriForPath: projectUri,
            },
            listProjectInstructions,
          ),
        ],
        paths,
      );
      const userSkillDirectory = new UserSkillDirectory(userRuleRoot, userRuleStore.caseSensitive);
      const skillRoot = userSkillDirectory.path;
      const userSkillIndex = (this.userSkillIndex ??= new RustWorkspacePathIndex({
        binaryPath: indexExecutable,
        root: skillRoot,
        caseSensitive: userRuleStore.caseSensitive,
        accessPolicy: userInstructionPolicy,
        respectGitIgnore: false,
      }));
      const userSkills = new FileSkillDiscoveryProvider({
        origin: { id: 'user:glyph', label: 'User skill', scope: 'user', compatibility: 'glyph' },
        directory: 'skills',
        matchesLegacyId: (directory, previousId, budget) =>
          userSkillDirectory.matchesProjectReference(directory, previousId, budget),
        captureFiles: (directory, signal) =>
          listSkillPackageFiles(userInstructionStore, directory, indexExecutable, false, signal, userInstructionPolicy),
        workspace: userInstructionStore,
        binaryStore: userInstructionStore,
        uriForPath: path => userRuleUri(userRuleRoot, path),
        listFiles: async signal => {
          await mkdir(skillRoot, { recursive: true });
          await userInstructionStore.canonicalPath('skills');
          const result = await userSkillIndex.glob('**/*', { limit: 10_000, ...(signal ? { signal } : {}) });
          return { ...result, files: result.files.map(path => `skills/${path}`) };
        },
        refreshIndex: async () => {
          await userSkillIndex.refresh();
        },
      });
      const skillState = (this.skillState ??= new SkillStateStore(userRuleStore, filesystemMetadata));
      let userMutations = mutationRoots.get(userRuleRoot);
      let openingUserMutations: Promise<NativeWorkspaceMutations> | undefined;
      const ensureSkillsReady = async () => {
        if (!userMutations) {
          await mkdir(userRuleRoot, { recursive: true });
          userMutations = await (openingUserMutations ??= NativeWorkspaceMutations.open(
            workspaceMutationsExecutable,
            userRuleRoot,
          ).catch(error => {
            openingUserMutations = undefined;
            throw error;
          }));
        }
        await skillState.initialize();
      };
      const skillIdentities = new Map<string, ProjectSkillIdentity>();
      skills = new SkillCatalog(
        [
          userSkills,
          ...physicalParts.flatMap(part =>
            ['.glyph', '.cursor'].map(location => {
              const identity = new ProjectSkillIdentity(part.disk.root, location);
              skillIdentities.set(identity.originId, identity);
              return new FileSkillDiscoveryProvider({
                includeDirectory: directory => !userSkillDirectory.ownsStore(dirname(join(part.disk.root, directory))),
                packageId: directory => identity.forDirectory(directory),
                matchesLegacyId: (directory, previousId, budget) =>
                  identity.matchesLegacyId(directory, previousId, budget),
                origin: {
                  id: identity.originId,
                  label: `${part.name} ${location} skill`,
                  scope: 'project',
                  compatibility: location.slice(1),
                },
                directory: `${location}/skills`,
                captureFiles: (directory, signal) =>
                  listSkillPackageFiles(part.disk, directory, indexExecutable, true, signal),
                workspace: part.catalog,
                binaryStore: part.disk,
                ...(parts.length > 1 ? { scopePrefix: part.name } : {}),
                uriForPath: path => userRuleUri(part.disk.root, path),
                listFiles: signal =>
                  part.index.glob(`**/${location}/skills/**/*`, { limit: 10_000, ...(signal ? { signal } : {}) }),
                refreshIndex: async () => {
                  await part.index.refresh();
                },
              });
            }),
          ),
        ],
        skillState.enabled,
        skillState.installations,
        ensureSkillsReady,
        (originId, directory) => skillManager!.recover(originId, directory),
        skillState.onDidChange.bind(skillState),
        routes,
        descriptors =>
          skillState.migratePackageIds(
            new Map(
              descriptors.flatMap(skill => {
                if (skill.origin.id === userSkills.id && skill.directory)
                  return [[skill.id, userSkillDirectory.previousPackageIds(skill.directory)] as const];
                const identity = skillIdentities.get(skill.origin.id);
                return identity && skill.directory ? [[skill.id, identity.legacyIds(skill.directory)] as const] : [];
              }),
            ),
          ),
      );
      skillManager = new SkillPackageManager(
        [
          {
            id: 'user:glyph',
            label: 'User skills',
            scope: 'user',
            get mutations() {
              return userMutations!;
            },
            assertClean: path =>
              assertUserWorkingCopiesClean(
                this.editors,
                input.identity,
                'skill',
                basename(path),
                userRuleStore.caseSensitive,
                path,
              ),
            store: userRuleStore,
            workspace: userRuleStore,
            directory: 'skills',
            listFiles: async () => {
              const result = await userSkillIndex.glob('**/*', { limit: 10000 });
              return { ...result, files: result.files.map(path => `skills/${path}`) };
            },
            listPackageDirectories: async directory =>
              (await listSkillPackageFiles(userRuleStore, directory, indexExecutable, false)).directories,
            refreshIndex: async () => {
              await userSkillIndex.refresh();
            },
          },
          ...physicalParts.map(part => {
            const identity = new ProjectSkillIdentity(part.disk.root, '.glyph');
            return {
              id: identity.originId,
              packageId: (directory: string) => identity.forDirectory(directory),
              label: `${part.name} project skills`,
              scope: 'project' as const,
              updateOnly: userSkillDirectory.ownsStore(join(part.disk.root, '.glyph/skills')),
              ...(parts.length > 1 ? { scopePrefix: part.name } : {}),
              mutations: mutationRoots.get(part.disk.root)!,
              assertClean: (path: string) => {
                const logicalRoot = input.roots.find(
                  candidate => getGlyphWorkspaceRootId(candidate, input.roots) === part.name,
                )!;
                const logicalDirectory = pathToFileURL(
                  join(fileURLToPath(logicalRoot.uri), relative(part.disk.root, path)),
                ).toString();
                const intersections = input.roots.flatMap((attached, rootIndex) => {
                  const uri = projectIntersection(attached, roots[rootIndex]!.path, path);
                  return uri && uri !== logicalDirectory ? [uri] : [];
                });
                return assertSkillPackageClean(
                  this.editors,
                  input.identity,
                  'project',
                  path,
                  logicalDirectory,
                  intersections,
                );
              },
              store: part.disk,
              workspace: part.workspace,
              directory: '.glyph/skills',
              listFiles: () => part.index.glob('**/.glyph/skills/**/*', { limit: 10000 }),
              listPackageDirectories: async (directory: string) =>
                (await listSkillPackageFiles(part.disk, directory, indexExecutable, true)).directories,
              refreshIndex: async () => {
                await part.index.refresh();
              },
            };
          }),
        ],
        skills,
        skillState,
        ensureSkillsReady,
      );
      turnContexts = new TurnContextCoordinator([
        new InstructionContextContributor(instructionCatalog),
        new SkillContextContributor(skills),
      ]);
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
            userRuleStore.caseSensitive,
            join(userRuleRoot, 'rules', filename),
          ),
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
        workspaceRoots: roots.map(workspaceRoot => workspaceRoot.path),
        stateDirectory: configuration.stateDirectory,
        protectedPaths: [artifactRoot],
        ...(input.trusted
          ? {
              privatePaths: () =>
                [...parts.map(part => join(part.disk.root, '.skill-staging')), this.userDirectory].filter(path =>
                  existsSync(path),
                ),
            }
          : {}),
        accessPolicy: policy,
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
          new ProjectAccess(root.path, { accessPolicy: policy }, workspace, index, turnContexts),
          new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
          reviews,
          logger,
          turnContexts,
          skillManager?.projectMutationPolicy ??
            new SkillProjectMutationPolicy([
              { store: { root: canonicalUserDirectory, caseSensitive: workspace.caseSensitive }, directory: 'skills' },
            ]),
        ),
        ...(turnContexts ? [new RuleToolRuntime(turnContexts), new SkillToolRuntime(turnContexts)] : []),
        ...(turnContexts && skillManager
          ? [
              new SkillLifecycleToolRuntime(
                skillManager,
                (preview, signal) => interactions.presentSkillChange(preview, signal),
                turnContexts,
                new SkillScriptRunner(
                  shells,
                  parts.map(part => ({
                    id: part.name,
                    label: part.name,
                    directory: part.disk.root,
                    workingDirectory: parts.length > 1 ? part.name : '.',
                    originIds: ['.glyph', '.cursor'].map(
                      location => new ProjectSkillIdentity(part.disk.root, location).originId,
                    ),
                  })),
                ),
              ),
            ]
          : []),
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
      new OpenAIProviderFactory(root.path, configuration, tools, client, turnContexts),
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
    // Reviews can read project files and the rules and skill resources advertised in their turn.
    const reviewProjectAccess = new ProjectAccess(root.path, { accessPolicy: policy }, workspace, index, turnContexts);
    const reviewTools = turnContexts
      ? new ToolRegistry([
          ...reviewProjectAccess.tools,
          ...new RuleToolRuntime(turnContexts).tools,
          ...new SkillToolRuntime(turnContexts).tools,
        ])
      : reviewProjectAccess;
    const reviewBackend = new OpenAIBackend(
      store,
      authentication,
      catalog,
      new OpenAIProviderFactory(root.path, configuration, reviewTools, client, turnContexts),
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
      glyph,
      agentReviews,
      interactions,
      shellSessions: shells,
      ...(instructionCatalog
        ? { instructionCatalog, referenceResources: (path: string) => routes.referenceResources(path) }
        : {}),
      ...(skills ? { skills } : {}),
      refreshCatalogs: async signal => {
        await Promise.all([instructionCatalog?.refresh(signal), skills?.refresh(signal)]);
      },
      instructionWatchRoots: userRules
        ? [
            userRules.directoryUri,
            userRuleUri(canonicalUserDirectory, 'skills'),
            userRuleUri(canonicalUserDirectory, 'skill-state.json'),
          ]
        : [],
      ...(skillManager
        ? {
            skillManager,
            skillSources: new SkillPackageSourceReader(
              indexExecutable,
              roots.map(workspaceRoot => workspaceRoot.path),
            ),
          }
        : {}),
      ...(userRules ? { userRules } : {}),
      emit: input.emit,
      ownerWindowId: input.identity.windowId,
      trusted: input.trusted,
    });
    return runtime;
  }

  async dispose(): Promise<void> {
    await this.initialized;
    try {
      const results = await Promise.allSettled([this.userRuleIndex?.dispose(), this.userSkillIndex?.dispose()]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await this.accounts.dispose();
    }
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
