#!/usr/bin/env node
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { WebToolRuntime } from './web/WebToolRuntime.ts';
import { AuthorizedWebTransport } from './web/AuthorizedWebTransport.ts';
import { WebApprovalService } from './web/WebApprovalService.ts';
import { FileApprovalStore } from './interaction/approvals/FileApprovalStore.ts';
import { QuestionApprovalPresenter } from './interaction/approvals/QuestionApprovalPresenter.ts';
import { WebHttpClient } from './web/WebHttpClient.ts';
import { WebFetchService } from './web/WebFetchService.ts';
import { DuckDuckGoSearch } from './web/DuckDuckGoSearch.ts';
import { createHash } from 'node:crypto';
import { SkillProjectMutationPolicy } from './skills/SkillProjectMutationPolicy.ts';
import { join, resolve } from 'node:path';
import { GlyphService } from './application/GlyphService.ts';
import { ChatSessionManager } from './chat/sessions/ChatSessionManager.ts';
import { SqliteChatSessionStore } from './chat/sessions/SqliteChatSessionStore.ts';
import { ContextAttachmentService } from './context/attachments/ContextAttachmentService.ts';
import { MultiRootWorkspacePathIndex } from './context/search/MultiRootWorkspacePathIndex.ts';
import { RustWorkspacePathIndex } from './context/search/RustWorkspacePathIndex.ts';
import type { WorkspacePathIndex } from './context/search/WorkspacePathIndex.ts';
import { EnvironmentConfigurationProvider } from './configuration/EnvironmentConfigurationProvider.ts';
import { ConfigurationError } from './errors/ConfigurationError.ts';
import { EditProposalService } from './editing/proposals/EditProposalService.ts';
import { getEditingReadBudget } from './editing/configuration/getEditingReadBudget.ts';
import { ProposalReviewManager } from './editing/reviews/ProposalReviewManager.ts';
import { FileProposalReviewStore } from './editing/reviews/persistence/FileProposalReviewStore.ts';
import { JsDiffTextDiffer } from './editing/documents/JsDiffTextDiffer.ts';
import { describeError } from './describeError.ts';
import { FetchHttpClient } from './http/FetchHttpClient.ts';
import { FileLogger } from './observability/FileLogger.ts';
import { ProposeQuestionToolRuntime } from './interaction/questions/ProposeQuestionToolRuntime.ts';
import { ProjectAccess } from './project/ProjectAccess.ts';
import type { ProjectContext } from './project/context/ProjectContext.ts';
import { ProjectContextKind } from './project/context/ProjectContextKind.ts';
import { ProjectContextResolver } from './project/context/ProjectContextResolver.ts';
import { ProjectToolRuntime } from './project/ProjectToolRuntime.ts';
import { OpenAIModelCatalog } from './providers/openai/OpenAIModelCatalog.ts';
import { OpenAIBackend } from './providers/openai/OpenAIBackend.ts';
import { OpenAIProviderFactory } from './providers/openai/OpenAIProviderFactory.ts';
import { OpenAIAuthenticationClient } from './providers/openai/auth/OpenAIAuthenticationClient.ts';
import { OpenAISession } from './providers/openai/auth/OpenAISession.ts';
import { FileOpenAIAccountStore } from './providers/openai/auth/FileOpenAIAccountStore.ts';
import { TerminalApplication } from './terminal/TerminalApplication.ts';
import { TerminalEditReviewer } from './terminal/ui/proposal/TerminalEditReviewer.ts';
import { ShutdownSignal } from './terminal/ShutdownSignal.ts';
import { TerminalUI } from './terminal/TerminalUI.tsx';
import { installShutdownHandlers } from './terminal/installShutdownHandlers.ts';
import { ToolRegistry } from './tools/ToolRegistry.ts';
import { FileSystemWorkspaceTextStore } from './workspace/FileSystemWorkspaceTextStore.ts';
import { MultiRootWorkspaceTextStore } from './workspace/MultiRootWorkspaceTextStore.ts';
import type { WorkspaceTextStore } from './workspace/WorkspaceTextStore.ts';
import { StartupUserProfile } from './workspace/policy/StartupUserProfile.ts';
import { WorkspaceContentAccess } from './workspace/policy/WorkspaceContentAccess.ts';
import { WorkspaceRootAccess } from './workspace/policy/WorkspaceRootAccess.ts';
import { homedir } from 'node:os';
import { NativeShellSandboxLauncher } from './shell/NativeShellSandboxLauncher.ts';
import { ShellCommandAuthorizer } from './shell/ShellCommandAuthorizer.ts';
import { ShellSessionManager } from './shell/ShellSessionManager.ts';
import { assertShellRuntimePathIsolation } from './shell/ShellRuntimePathPolicy.ts';
import { ShellToolRuntime } from './shell/ShellToolRuntime.ts';
import { ShellWorkingDirectoryResolver } from './shell/ShellWorkingDirectoryResolver.ts';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      `Glyph | Sign in with ChatGPT\nUsage: glyph [--workspace <file.code-workspace>]\n\n${TerminalUI.help}\n`,
    );
    return;
  }
  if (!process.stdin.isTTY)
    throw new Error('Run pnpm start in an interactive terminal for account and model selection.');

  const shutdown = new AbortController();
  const configuration = new EnvironmentConfigurationProvider();
  const projectContext = await ProjectContextResolver.resolve({
    currentDirectory: process.cwd(),
    ...workspaceArgument(process.argv.slice(2)),
  });
  assertShellRuntimePathIsolation(
    projectContext.roots.map(root => root.path),
    configuration.stateDirectory,
    configuration.traceFile,
  );
  const logger = new FileLogger(configuration.traceFile);
  const http = new FetchHttpClient(logger);
  const store = new FileOpenAIAccountStore(configuration.stateDirectory);
  const packageRoot = resolve(import.meta.dirname, '..');
  const indexExecutable = resolve(
    packageRoot,
    'target',
    'release',
    process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
  );
  const shellSandboxExecutable = resolve(
    packageRoot,
    'target',
    'release',
    process.platform === 'win32' ? 'glyph-shell-sandbox.exe' : 'glyph-shell-sandbox',
  );
  using profile = new StartupUserProfile(process.env.GLYPH_USER_DIRECTORY ?? join(homedir(), '.glyph'));
  const hostPrivate = [configuration.stateDirectory, configuration.traceFile, join(profile.path, 'skill-state.json')];
  const installation = [indexExecutable, shellSandboxExecutable];
  if (
    projectContext.roots.some(root =>
      [...hostPrivate, ...installation].some(path => resolve(path) === resolve(root.path)),
    )
  )
    throw new ConfigurationError('Glyph state, trace, and native-worker paths must not be the project root.');
  const access = new WorkspaceContentAccess(
    profile,
    () => hostPrivate,
    installation,
    projectContext.roots.map(root => root.path),
  );
  const { workspace, selectedFiles, pathIndex } = await createProjectRuntime(
    projectContext,
    configuration.stateDirectory,
    indexExecutable,
    access,
    profile.path,
  );
  const ui = new TerminalUI(process.stdin, process.stdout, process.stderr, pathIndex);
  const shellAuthorizer = new ShellCommandAuthorizer(
    { workspaceId: projectContext.id, mutationScope: projectContext.mutationIdentity },
    new FileApprovalStore(join(configuration.stateDirectory, 'projects', projectContext.mutationIdentity)),
    ui,
  );
  const shellSessions = new ShellSessionManager(
    shellAuthorizer,
    new ShellWorkingDirectoryResolver(projectContext),
    new NativeShellSandboxLauncher({
      binaryPath: shellSandboxExecutable,
      workspaceRoots: projectContext.roots.map(root => root.path),
      stateDirectory: configuration.stateDirectory,
      protectedPaths: [packageRoot, indexExecutable, shellSandboxExecutable],
      accessPolicy: access.shell,
    }),
  );
  ui.connectShellSessions(shellSessions);
  const authentication = new OpenAIAuthenticationClient(configuration.openAI, http);
  const session = new OpenAISession(store, authentication, configuration.openAI, shutdown.signal);
  const proposalReviews = new ProposalReviewManager(
    workspace,
    new FileProposalReviewStore(join(configuration.stateDirectory, 'projects', projectContext.id), {
      mutationScope: projectContext.mutationIdentity,
    }),
    logger,
    configuration.editing.maxActiveReviews,
    projectContext.mutationIdentity,
    { maxReadBytes: getEditingReadBudget(configuration.editing), autoApply: true },
  );
  const projectTools = new ProjectToolRuntime(
    new ProjectAccess(workspace, pathIndex),
    new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
    proposalReviews,
    logger,
    undefined,
    new SkillProjectMutationPolicy([
      { store: { root: profile.path, caseSensitive: workspace.caseSensitive }, directory: 'skills' },
    ]),
  );
  const webApproval = new WebApprovalService(
    { workspaceId: projectContext.id, mutationScope: projectContext.mutationIdentity },
    new FileApprovalStore(join(configuration.stateDirectory, 'projects', projectContext.id)),
    new QuestionApprovalPresenter(ui),
  );
  const webHttp = new WebHttpClient(
    new AuthorizedWebTransport((destination, signal) => webApproval.request(destination, signal)),
  );
  const tools = new ToolRegistry(
    [
      projectTools,
      new WebToolRuntime(new WebFetchService(webHttp), new DuckDuckGoSearch(webHttp)),
      new ProposeQuestionToolRuntime(ui),
      new ShellToolRuntime(shellSessions),
    ].flatMap(source => source.tools),
  );
  const backend = new OpenAIBackend(
    store,
    session,
    new OpenAIModelCatalog(configuration.openAI, http),
    new OpenAIProviderFactory(configuration, tools),
    configuration.openAI,
  );
  const glyph = new GlyphService(
    backend,
    logger,
    { traceEnabled: configuration.traceEnabled },
    proposalReviews,
    new ContextAttachmentService(selectedFiles, configuration.contextAttachments),
    pathIndex,
    new ChatSessionManager(new SqliteChatSessionStore(configuration.stateDirectory), projectContext),
  );
  const application = new TerminalApplication(
    glyph,
    ui,
    shutdown.signal,
    {
      projectContext,
      ...(configuration.configuredModel !== undefined && configuration.configuredModel !== ''
        ? { configuredModel: configuration.configuredModel }
        : {}),
    },
    new TerminalEditReviewer(ui, () => {
      process.exitCode = 130;
      shutdown.abort();
    }),
    shellSessions,
  );

  let closed = false;
  let shutdownKeepAlive: NodeJS.Timeout | undefined;
  ui.onClose(() => {
    closed = true;
    shutdown.abort();
    application.active?.abort();
  });
  const removeShutdownHandlers = installShutdownHandlers({
    active: () => application.active,
    interrupt: ui,
    shutdown: (signal: ShutdownSignal) => {
      if (closed) return;
      closed = true;
      // A pending terminal question does not keep Node alive after close().
      // Hold the loop until TerminalApplication disposes the store lock.
      shutdownKeepAlive = setInterval(() => {}, 1_000);
      process.exitCode = signal === ShutdownSignal.SIGINT ? 130 : 143;
      shutdown.abort();
      ui.close();
    },
  });

  try {
    const exitCode = await application.run();
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    removeShutdownHandlers();
    ui.close();
    if (shutdownKeepAlive) clearInterval(shutdownKeepAlive);
  }
}

function workspaceArgument(arguments_: readonly string[]): { workspaceFile?: string } {
  const index = arguments_.findIndex(argument => argument === '--workspace' || argument.startsWith('--workspace='));
  if (index < 0) return {};
  const argument = arguments_[index]!;
  const workspaceFile = argument === '--workspace' ? arguments_[index + 1] : argument.slice('--workspace='.length);
  if (workspaceFile === undefined || workspaceFile === '' || workspaceFile.startsWith('--')) {
    throw new ConfigurationError('--workspace requires a .code-workspace file path.');
  }
  return { workspaceFile };
}

async function createProjectRuntime(
  context: ProjectContext,
  stateDirectory: string,
  indexExecutable: string,
  policy: WorkspaceContentAccess,
  profilePath: string,
): Promise<{ workspace: WorkspaceTextStore; selectedFiles: WorkspaceTextStore; pathIndex: WorkspacePathIndex }> {
  const physicalAccess = new NativeFilesystemMetadata(indexExecutable);
  const casing = await Promise.all(
    context.roots.map(root => RustWorkspacePathIndex.filesystemCaseSensitive(indexExecutable, root.path)),
  );
  const roots = context.roots.map((root, i) => {
    const access = new WorkspaceRootAccess(policy.project, root.path, casing[i]!);
    const workspace = new FileSystemWorkspaceTextStore(root.path, {
      access,
      physicalAccess,
      managedDirectories: [join(profilePath, 'skills')],
    });
    const selectedFiles = new FileSystemWorkspaceTextStore(root.path, {
      access: new WorkspaceRootAccess(policy.selectedFile, root.path, casing[i]!),
      physicalAccess,
    });
    const cacheName = createHash('sha256').update(`${context.id}\0${root.name}\0${root.path}`).digest('hex');
    const pathIndex = new RustWorkspacePathIndex({
      binaryPath: indexExecutable,
      access,
      cachePath: join(stateDirectory, `context-index-${cacheName}.bin`),
    });
    return { name: root.name, workspace, selectedFiles, pathIndex };
  });
  if (context.kind === ProjectContextKind.FOLDER) {
    const root = roots[0]!;
    return { workspace: root.workspace, selectedFiles: root.selectedFiles, pathIndex: root.pathIndex };
  }
  return {
    workspace: new MultiRootWorkspaceTextStore(
      context,
      roots.map(root => ({ name: root.name, store: root.workspace })),
    ),
    selectedFiles: new MultiRootWorkspaceTextStore(
      context,
      roots.map(root => ({ name: root.name, store: root.selectedFiles })),
    ),
    pathIndex: new MultiRootWorkspacePathIndex(
      context.id,
      roots.map(root => ({ name: root.name, index: root.pathIndex })),
    ),
  };
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${TerminalUI.clean(describeError(error))}\n`);
  process.exitCode = 1;
}
