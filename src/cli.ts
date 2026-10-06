#!/usr/bin/env node
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessService } from './application/HarnessService.ts';
import { ContextAttachmentService } from './context/attachments/ContextAttachmentService.ts';
import { RustWorkspaceFileSearch } from './context/search/RustWorkspaceFileSearch.ts';
import { EnvironmentConfigurationProvider } from './configuration/EnvironmentConfigurationProvider.ts';
import { ConfigurationError } from './errors/ConfigurationError.ts';
import { EditProposalService } from './editing/proposals/EditProposalService.ts';
import { ProposalReviewManager } from './editing/reviews/ProposalReviewManager.ts';
import { FileProposalReviewStore } from './editing/reviews/persistence/FileProposalReviewStore.ts';
import { JsDiffTextDiffer } from './editing/documents/JsDiffTextDiffer.ts';
import { describeError } from './describeError.ts';
import { FetchHttpClient } from './http/FetchHttpClient.ts';
import { FileLogger } from './observability/FileLogger.ts';
import { ProjectAccess } from './project/ProjectAccess.ts';
import { ProjectToolRuntime } from './project/ProjectToolRuntime.ts';
import { OpenAIModelCatalog } from './providers/openai/OpenAIModelCatalog.ts';
import { OpenAIProviderFactory } from './providers/openai/OpenAIProviderFactory.ts';
import { OpenAIAuthenticationClient } from './providers/openai/auth/OpenAIAuthenticationClient.ts';
import { OpenAISession } from './providers/openai/auth/OpenAISession.ts';
import { FileOpenAIAccountStore } from './providers/openai/auth/FileOpenAIAccountStore.ts';
import { TerminalApplication } from './terminal/TerminalApplication.ts';
import { TerminalEditReviewer } from './terminal/TerminalEditReviewer.ts';
import { TerminalInput } from './terminal/TerminalInput.ts';
import { ShutdownSignal } from './terminal/ShutdownSignal.ts';
import { TerminalUI } from './terminal/TerminalUI.ts';
import { installShutdownHandlers } from './terminal/installShutdownHandlers.ts';
import { FileSystemWorkspaceTextStore } from './workspace/FileSystemWorkspaceTextStore.ts';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(`Harness Chat | Sign in with ChatGPT\n${TerminalUI.help}\n`);
    return;
  }
  if (!process.stdin.isTTY)
    throw new Error('Run npm start in an interactive terminal for account and model selection.');

  const shutdown = new AbortController();
  const configuration = new EnvironmentConfigurationProvider();
  const projectRoot = process.cwd();
  if (resolve(configuration.stateDirectory) === resolve(projectRoot)) {
    throw new ConfigurationError(
      'HARNESS_CHAT_CONFIG_DIR must not be the project root because harness state contains credentials and provider traces.',
    );
  }
  const logger = new FileLogger(configuration.traceFile);
  const http = new FetchHttpClient(logger);
  const store = new FileOpenAIAccountStore(configuration.stateDirectory);
  const terminalInput = new TerminalInput();
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const indexExecutable = resolve(
    process.env.HARNESS_CHAT_CONTEXT_INDEX_BINARY ??
      resolve(
        packageRoot,
        'target',
        'release',
        process.platform === 'win32' ? 'harness-context-index.exe' : 'harness-context-index',
      ),
  );
  const excludedPaths = [
    ...new Set(
      [
        projectRelativeExclusion(projectRoot, configuration.stateDirectory),
        projectRelativeExclusion(projectRoot, configuration.traceFile),
        projectRelativeExclusion(projectRoot, indexExecutable),
      ].filter((path): path is string => path !== undefined),
    ),
  ];
  const fileSearch = new RustWorkspaceFileSearch({
    binaryPath: indexExecutable,
    root: projectRoot,
    cachePath: join(configuration.stateDirectory, 'context-index.bin'),
    excludedPaths,
  });
  const ui = new TerminalUI(terminalInput, process.stdout, process.stderr, fileSearch);
  const authentication = new OpenAIAuthenticationClient(configuration.openAI, http);
  const session = new OpenAISession(store, authentication, configuration.openAI, shutdown.signal);
  const workspace = new FileSystemWorkspaceTextStore(projectRoot, { excludedPaths });
  const proposalReviews = new ProposalReviewManager(
    workspace,
    new FileProposalReviewStore(configuration.stateDirectory),
    logger,
    configuration.editing.maxActiveReviews,
  );
  const projectTools = new ProjectToolRuntime(
    new ProjectAccess(projectRoot, {}, workspace),
    new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
    proposalReviews,
    logger,
  );
  const harness = new HarnessService(
    store,
    session,
    new OpenAIModelCatalog(configuration.openAI, http),
    new OpenAIProviderFactory(projectRoot, configuration, projectTools),
    logger,
    configuration.openAI,
    { traceEnabled: configuration.traceEnabled },
    proposalReviews,
    new ContextAttachmentService(workspace, configuration.contextAttachments),
    fileSearch,
  );
  const application = new TerminalApplication(
    harness,
    ui,
    shutdown.signal,
    {
      projectRoot,
      ...(configuration.configuredModel ? { configuredModel: configuration.configuredModel } : {}),
    },
    new TerminalEditReviewer(terminalInput, process.stdout, () => {
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

function projectRelativeExclusion(root: string, target: string): string | undefined {
  const fromRoot = relative(resolve(root), resolve(target));
  if (!fromRoot) {
    throw new ConfigurationError('Harness state, trace, and native-worker paths must not be the project root.');
  }
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
  return fromRoot.split(sep).join('/');
}

main().catch(error => {
  process.stderr.write(`${TerminalUI.clean(describeError(error))}\n`);
  process.exitCode = 1;
});
