#!/usr/bin/env node
import { HarnessService } from './application/HarnessService.ts';
import { EnvironmentConfigurationProvider } from './configuration/EnvironmentConfigurationProvider.ts';
import { EditProposalService } from './editing/EditProposalService.ts';
import { EditSessionManager } from './editing/EditSessionManager.ts';
import { FileEditSessionStore } from './editing/FileEditSessionStore.ts';
import { JsDiffTextDiffer } from './editing/JsDiffTextDiffer.ts';
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
  if (!process.stdin.isTTY) throw new Error('Run npm start in an interactive terminal for account and model selection.');

  const shutdown = new AbortController();
  const configuration = new EnvironmentConfigurationProvider();
  const logger = new FileLogger(configuration.traceFile);
  const http = new FetchHttpClient(logger);
  const store = new FileOpenAIAccountStore(configuration.stateDirectory);
  const terminalInput = new TerminalInput();
  const ui = new TerminalUI(terminalInput);
  const authentication = new OpenAIAuthenticationClient(configuration.openAI, http);
  const session = new OpenAISession(store, authentication, configuration.openAI, shutdown.signal);
  const workspace = new FileSystemWorkspaceTextStore(process.cwd());
  const editSessions = new EditSessionManager(
    workspace,
    new FileEditSessionStore(configuration.stateDirectory),
    logger,
    configuration.editing.maxActiveSessions,
  );
  const projectTools = new ProjectToolRuntime(
    new ProjectAccess(process.cwd(), {}, workspace),
    new EditProposalService(workspace, new JsDiffTextDiffer(), configuration.editing, logger),
    editSessions,
    logger,
  );
  const harness = new HarnessService(
    store,
    session,
    new OpenAIModelCatalog(configuration.openAI, http),
    new OpenAIProviderFactory(process.cwd(), configuration, projectTools),
    logger,
    configuration.openAI,
    { traceEnabled: configuration.traceEnabled },
    editSessions,
  );
  const application = new TerminalApplication(harness, ui, shutdown.signal, {
    projectRoot: process.cwd(),
    ...(configuration.configuredModel ? { configuredModel: configuration.configuredModel } : {}),
  }, new TerminalEditReviewer(terminalInput, process.stdout, () => {
    process.exitCode = 130;
    shutdown.abort();
  }));

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

main().catch(error => {
  process.stderr.write(`${TerminalUI.clean(describeError(error))}\n`);
  process.exitCode = 1;
});
