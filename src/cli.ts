#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { OpenAIProviderFactory } from './providers/openai/OpenAIProviderFactory.ts';
import { OpenAIAuthenticationClient } from './providers/openai/auth/OpenAIAuthenticationClient.ts';
import { OpenAISession } from './providers/openai/auth/OpenAISession.ts';
import { FileOpenAIAccountStore } from './providers/openai/auth/FileOpenAIAccountStore.ts';
import { TerminalApplication } from './terminal/TerminalApplication.ts';
import { TerminalEditReviewer } from './terminal/ui/proposal/TerminalEditReviewer.ts';
import { ShutdownSignal } from './terminal/ShutdownSignal.ts';
import { TerminalUI } from './terminal/TerminalUI.tsx';
import { installShutdownHandlers } from './terminal/installShutdownHandlers.ts';
import { CompositeToolRuntime } from './tools/CompositeToolRuntime.ts';
import { FileSystemWorkspaceTextStore } from './workspace/FileSystemWorkspaceTextStore.ts';
import { MultiRootWorkspaceTextStore } from './workspace/MultiRootWorkspaceTextStore.ts';
import type { WorkspaceTextStore } from './workspace/WorkspaceTextStore.ts';

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
  if (projectContext.roots.some(root => resolve(configuration.stateDirectory) === root.path)) {
    throw new ConfigurationError(
      'GLYPH_CONFIG_DIR must not be the project root because Glyph state contains credentials and provider traces.',
    );
  }
  const logger = new FileLogger(configuration.traceFile);
  const http = new FetchHttpClient(logger);
  const store = new FileOpenAIAccountStore(configuration.stateDirectory);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const indexExecutable = resolve(
    process.env.GLYPH_CONTEXT_INDEX_BINARY ??
      resolve(
        packageRoot,
        'target',
        'release',
        process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
      ),
  );
  const { workspace, pathIndex } = createProjectRuntime(
    projectContext,
    configuration.stateDirectory,
    configuration.traceFile,
    indexExecutable,
  );
  const ui = new TerminalUI(process.stdin, process.stdout, process.stderr, pathIndex);
  const authentication = new OpenAIAuthenticationClient(configuration.openAI, http);
  const session = new OpenAISession(store, authentication, configuration.openAI, shutdown.signal);
  const proposalReviews = new ProposalReviewManager(
    workspace,
    new FileProposalReviewStore(join(configuration.stateDirectory, 'projects', projectContext.id)),
    logger,
    configuration.editing.maxActiveReviews,
    projectContext.id,
  );
  const projectTools = new ProjectToolRuntime(
    new ProjectAccess(projectContext.roots[0]!.path, {}, workspace, pathIndex),
    new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
    proposalReviews,
    logger,
  );
  const tools = new CompositeToolRuntime([projectTools, new ProposeQuestionToolRuntime(ui)]);
  const glyph = new GlyphService(
    store,
    session,
    new OpenAIModelCatalog(configuration.openAI, http),
    new OpenAIProviderFactory(projectContext.roots[0]!.path, configuration, tools),
    logger,
    configuration.openAI,
    { traceEnabled: configuration.traceEnabled },
    proposalReviews,
    new ContextAttachmentService(workspace, configuration.contextAttachments),
    pathIndex,
    new ChatSessionManager(new SqliteChatSessionStore(configuration.stateDirectory), projectContext),
  );
  const application = new TerminalApplication(
    glyph,
    ui,
    shutdown.signal,
    {
      projectContext,
      ...(configuration.configuredModel ? { configuredModel: configuration.configuredModel } : {}),
    },
    new TerminalEditReviewer(ui, () => {
      process.exitCode = 130;
      shutdown.abort();
    }),
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
  if (!workspaceFile || workspaceFile.startsWith('--')) {
    throw new ConfigurationError('--workspace requires a .code-workspace file path.');
  }
  return { workspaceFile };
}

function createProjectRuntime(
  context: ProjectContext,
  stateDirectory: string,
  traceFile: string,
  indexExecutable: string,
): { workspace: WorkspaceTextStore; pathIndex: WorkspacePathIndex } {
  const roots = context.roots.map(root => {
    const excludedPaths = [
      ...new Set(
        [
          projectRelativeExclusion(root.path, stateDirectory),
          projectRelativeExclusion(root.path, traceFile),
          projectRelativeExclusion(root.path, indexExecutable),
        ].filter((path): path is string => path !== undefined),
      ),
    ];
    const workspace = new FileSystemWorkspaceTextStore(root.path, { excludedPaths });
    const cacheName = createHash('sha256').update(`${context.id}\0${root.name}\0${root.path}`).digest('hex');
    const pathIndex = new RustWorkspacePathIndex({
      binaryPath: indexExecutable,
      root: root.path,
      cachePath: join(stateDirectory, `context-index-${cacheName}.bin`),
      excludedPaths,
      caseSensitive: workspace.caseSensitive,
    });
    return { name: root.name, workspace, pathIndex };
  });
  if (context.kind === ProjectContextKind.FOLDER) {
    const root = roots[0]!;
    return { workspace: root.workspace, pathIndex: root.pathIndex };
  }
  return {
    workspace: new MultiRootWorkspaceTextStore(
      context,
      roots.map(root => ({ name: root.name, store: root.workspace })),
    ),
    pathIndex: new MultiRootWorkspacePathIndex(
      context.id,
      roots.map(root => ({ name: root.name, index: root.pathIndex })),
    ),
  };
}

function projectRelativeExclusion(root: string, target: string): string | undefined {
  const fromRoot = relative(resolve(root), resolve(target));
  if (!fromRoot) {
    throw new ConfigurationError('Glyph state, trace, and native-worker paths must not be the project root.');
  }
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
  return fromRoot.split(sep).join('/');
}

main().catch(error => {
  process.stderr.write(`${TerminalUI.clean(describeError(error))}\n`);
  process.exitCode = 1;
});
