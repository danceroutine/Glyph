import { createHash } from 'node:crypto';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { ShutdownSignal } from '#src/terminal/ShutdownSignal.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('glyph command line', () => {
  it('prints usage help without starting a terminal session', async () => {
    const cli = prepareCli({ argv: ['--help'] });

    await cli.start();

    expect(cli.stdout).toHaveBeenCalledWith(
      'Glyph | Sign in with ChatGPT\nUsage: glyph [--workspace <file.code-workspace>]\n\nTERMINAL HELP\n',
    );
    expect(cli.instances('TerminalApplication')).toEqual([]);
  });

  it('refuses to start without an interactive terminal', async () => {
    const cli = prepareCli({ interactive: false });

    await cli.start();

    await expect(cli.reported).resolves.toBe(
      'Run pnpm start in an interactive terminal for account and model selection.\n',
    );
    expect(process.exitCode).toBe(1);
    expect(cli.instances('TerminalApplication')).toEqual([]);
  });

  it('runs a folder project with runtime paths excluded from the workspace', async () => {
    const root = repositoryRoot;
    const stateDirectory = join(root, '.glyph', 'state');
    const traceFile = '/var/log/glyph/trace.log';
    const context = folderContext(root);
    const cli = prepareCli({ context, configuration: { stateDirectory, traceFile } });

    await cli.start();
    await cli.finished;

    expect(cli.resolveProject).toHaveBeenCalledWith({ currentDirectory: process.cwd() });
    expect(cli.assertPathIsolation).toHaveBeenCalledWith([root], stateDirectory, traceFile);
    const excludedPaths = ['.glyph/state', 'target/release/glyph-context-index', 'target/release/glyph-shell-sandbox'];
    const [workspace] = cli.instances('FileSystemWorkspaceTextStore');
    const [accessPolicy] = cli.instances('WorkspaceAccessPolicy');
    expect(workspace?.args).toEqual([root, { excludedPaths, accessPolicy }]);
    const cacheName = createHash('sha256').update(`${context.id}\0${'Repository'}\0${root}`).digest('hex');
    const [pathIndex] = cli.instances('RustWorkspacePathIndex');
    expect(pathIndex?.args).toEqual([
      {
        binaryPath: join(root, 'target', 'release', 'glyph-context-index'),
        root,
        cachePath: join(stateDirectory, `context-index-${cacheName}.bin`),
        excludedPaths,
        accessPolicy,
        caseSensitive: true,
      },
    ]);
    expect(cli.instances('MultiRootWorkspaceTextStore')).toEqual([]);
    expect(cli.instances('MultiRootWorkspacePathIndex')).toEqual([]);
    const [ui] = cli.instances('TerminalUI');
    expect(ui?.args).toEqual([process.stdin, process.stdout, process.stderr, pathIndex]);
    const [shellSessions] = cli.instances('ShellSessionManager');
    expect(cli.connectShellSessions).toHaveBeenCalledWith(shellSessions);
    const [launcher] = cli.instances('NativeShellSandboxLauncher');
    expect(launcher?.args).toEqual([
      {
        binaryPath: join(root, 'target', 'release', 'glyph-shell-sandbox'),
        workspaceRoots: [root],
        stateDirectory,
        protectedPaths: [
          root,
          join(root, 'target', 'release', 'glyph-context-index'),
          join(root, 'target', 'release', 'glyph-shell-sandbox'),
        ],
        accessPolicy,
      },
    ]);
    const [registry] = cli.instances('ToolRegistry');
    expect(registry?.args).toEqual([
      ['ProjectToolRuntime', 'WebToolRuntime', 'ProposeQuestionToolRuntime', 'ShellToolRuntime'],
    ]);
    const [application] = cli.instances('TerminalApplication');
    const [glyph] = cli.instances('GlyphService');
    const [reviewer] = cli.instances('TerminalEditReviewer');
    expect(application?.args).toEqual([
      glyph,
      ui,
      expect.any(AbortSignal),
      { projectContext: context },
      reviewer,
      shellSessions,
    ]);
    expect(glyph?.args[2]).toEqual({ traceEnabled: true });
    expect(cli.run).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
    expect(cli.closeUI).toHaveBeenCalledOnce();
  });

  it('runs a multi-root workspace chosen on the command line with the configured model', async () => {
    const context: ProjectContext = {
      id: 'workspace',
      mutationIdentity: 'workspace-roots',
      kind: ProjectContextKind.WORKSPACE,
      name: 'Workspace',
      authority: 'local',
      roots: [
        { name: 'App', path: '/work/app' },
        { name: 'Docs', path: '/work/docs' },
      ],
    };
    const cli = prepareCli({
      argv: ['--workspace', 'project.code-workspace'],
      context,
      configuration: { stateDirectory: '/work/app/.state', traceFile: '/work', configuredModel: 'gpt-test' },
    });

    await cli.start();
    await cli.finished;

    expect(cli.resolveProject).toHaveBeenCalledWith({
      currentDirectory: process.cwd(),
      workspaceFile: 'project.code-workspace',
    });
    const [appStore, docsStore] = cli.instances('FileSystemWorkspaceTextStore');
    expect(appStore?.args[1]).toMatchObject({ excludedPaths: ['.state'] });
    expect(docsStore?.args[1]).toMatchObject({ excludedPaths: [] });
    const [appIndex, docsIndex] = cli.instances('RustWorkspacePathIndex');
    const [workspace] = cli.instances('MultiRootWorkspaceTextStore');
    expect(workspace?.args).toEqual([
      context,
      [
        { name: 'App', store: appStore },
        { name: 'Docs', store: docsStore },
      ],
    ]);
    const [pathIndex] = cli.instances('MultiRootWorkspacePathIndex');
    expect(pathIndex?.args).toEqual([
      'workspace',
      [
        { name: 'App', index: appIndex },
        { name: 'Docs', index: docsIndex },
      ],
    ]);
    expect(cli.instances('TerminalUI')[0]?.args[3]).toBe(pathIndex);
    expect(cli.instances('TerminalApplication')[0]?.args[3]).toEqual({
      projectContext: context,
      configuredModel: 'gpt-test',
    });
  });

  it('accepts a workspace file written as a single argument', async () => {
    const cli = prepareCli({ argv: ['--workspace=team.code-workspace'] });

    await cli.start();
    await cli.finished;

    expect(cli.resolveProject).toHaveBeenCalledWith({
      currentDirectory: process.cwd(),
      workspaceFile: 'team.code-workspace',
    });
  });

  it.each([[['--workspace']], [['--workspace', '--verbose']], [['--workspace=']]])(
    'rejects %j without a workspace file path',
    async argv => {
      const cli = prepareCli({ argv });

      await cli.start();

      await expect(cli.reported).resolves.toBe('--workspace requires a .code-workspace file path.\n');
      expect(process.exitCode).toBe(1);
      expect(cli.resolveProject).not.toHaveBeenCalled();
    },
  );

  it('refuses runtime paths that coincide with the project root', async () => {
    const cli = prepareCli({
      context: folderContext('/work/app'),
      configuration: { stateDirectory: '/work/app', traceFile: '/var/log/trace.log' },
    });

    await cli.start();

    await expect(cli.reported).resolves.toBe(
      'Glyph state, trace, and native-worker paths must not be the project root.\n',
    );
    expect(process.exitCode).toBe(1);
    expect(cli.instances('TerminalApplication')).toEqual([]);
  });

  it('excludes Windows runtime paths only when they share the project drive', async () => {
    setPlatform('win32');
    vi.doMock('node:path', () => ({ ...win32, default: win32 }));
    onTestFinished(() => {
      vi.doUnmock('node:path');
    });
    const cli = prepareCli({
      context: folderContext('C:\\work\\app'),
      configuration: { stateDirectory: 'D:\\glyph\\state', traceFile: 'C:\\work\\app\\logs\\trace.log' },
    });

    await cli.start();
    await cli.finished;

    const [workspace] = cli.instances('FileSystemWorkspaceTextStore');
    const options = workspace?.args[1] as { excludedPaths: readonly string[] };
    expect(options.excludedPaths).toContain('logs/trace.log');
    expect(options.excludedPaths.some(path => path.includes('glyph') && path.includes('state'))).toBe(false);
    const [pathIndex] = cli.instances('RustWorkspacePathIndex');
    expect((pathIndex?.args[0] as { binaryPath: string }).binaryPath).toMatch(/glyph-context-index\.exe$/);
    const [launcher] = cli.instances('NativeShellSandboxLauncher');
    expect((launcher?.args[0] as { binaryPath: string }).binaryPath).toMatch(/glyph-shell-sandbox\.exe$/);
  });

  it('exits with the status returned by an unsuccessful terminal session', async () => {
    const cli = prepareCli();
    cli.run.mockResolvedValue(2);

    await cli.start();
    await cli.finished;

    expect(process.exitCode).toBe(2);
  });

  it('reports an unexpected terminal failure after releasing the terminal', async () => {
    const cli = prepareCli();
    cli.run.mockRejectedValue(new Error('Terminal crashed.'));

    await cli.start();

    await expect(cli.reported).resolves.toBe('Terminal crashed.\n');
    expect(cli.removeShutdownHandlers).toHaveBeenCalledOnce();
    expect(cli.closeUI).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('cancels the active request and stops the application when terminal input closes', async () => {
    const cli = prepareCli();
    cli.run.mockImplementation(async () => {
      const [application] = cli.instances('TerminalApplication');
      const shutdown = application?.args[2] as AbortSignal;
      cli.closeListeners.forEach(listener => listener());
      expect(shutdown.aborted).toBe(true);
      expect(cli.active.signal.aborted).toBe(true);
      cli.shutdownOptions()?.shutdown(ShutdownSignal.SIGINT);
      return 0;
    });

    await cli.start();
    await cli.finished;

    expect(process.exitCode).toBeUndefined();
    expect(cli.closeUI).toHaveBeenCalledOnce();
  });

  it.each([
    { signal: ShutdownSignal.SIGINT, exitCode: 130 },
    { signal: ShutdownSignal.SIGTERM, exitCode: 143 },
  ])('exits with status $exitCode after $signal once the application finishes', async ({ signal, exitCode }) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const cli = prepareCli();
    cli.run.mockImplementation(async () => {
      const [application] = cli.instances('TerminalApplication');
      const shutdown = application?.args[2] as AbortSignal;
      const options = cli.shutdownOptions();
      expect(options?.active()).toBe(cli.active);
      options?.shutdown(signal);
      options?.shutdown(signal);
      expect(shutdown.aborted).toBe(true);
      expect(cli.closeUI).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(2_000);
      expect(vi.getTimerCount()).toBe(1);
      return 0;
    });

    await cli.start();
    await cli.finished;

    expect(process.exitCode).toBe(exitCode);
    expect(vi.getTimerCount()).toBe(0);
    expect(cli.closeUI).toHaveBeenCalledTimes(2);
  });

  it('treats an interrupted review as an interrupted session', async () => {
    const cli = prepareCli();
    cli.run.mockImplementation(async () => {
      const [application] = cli.instances('TerminalApplication');
      const [reviewer] = cli.instances('TerminalEditReviewer');
      (reviewer?.args[1] as () => void)();
      expect((application?.args[2] as AbortSignal).aborted).toBe(true);
      return 0;
    });

    await cli.start();
    await cli.finished;

    expect(process.exitCode).toBe(130);
  });
});

interface Recorded {
  readonly args: unknown[];
}

interface PrepareOptions {
  readonly argv?: readonly string[];
  readonly interactive?: boolean;
  readonly context?: ProjectContext;
  readonly configuration?: { stateDirectory?: string; traceFile?: string; configuredModel?: string };
}

interface ShutdownOptions {
  active(): AbortController | undefined;
  shutdown(signal: ShutdownSignal): void;
}

function prepareCli({
  argv = [],
  interactive = true,
  context = folderContext('/work/app'),
  configuration = {},
}: PrepareOptions = {}) {
  const recorded = new Map<string, Recorded[]>();
  const record = (name: string) =>
    class {
      readonly args: unknown[];
      readonly tools = [name];
      readonly caseSensitive = true;

      constructor(...args: unknown[]) {
        this.args = args;
        recorded.set(name, [...(recorded.get(name) ?? []), this]);
      }
    };
  const mocked: string[] = [];
  const mock = (path: string, factory: () => Record<string, unknown>) => {
    mocked.push(path);
    vi.doMock(path, factory);
  };
  const recordedModules: Record<string, string> = {
    '#src/web/WebToolRuntime.js': 'WebToolRuntime',
    '#src/web/WebHttpClient.js': 'WebHttpClient',
    '#src/web/WebFetchService.js': 'WebFetchService',
    '#src/web/DuckDuckGoSearch.js': 'DuckDuckGoSearch',
    '#src/application/GlyphService.js': 'GlyphService',
    '#src/chat/sessions/ChatSessionManager.js': 'ChatSessionManager',
    '#src/chat/sessions/SqliteChatSessionStore.js': 'SqliteChatSessionStore',
    '#src/context/attachments/ContextAttachmentService.js': 'ContextAttachmentService',
    '#src/context/search/MultiRootWorkspacePathIndex.js': 'MultiRootWorkspacePathIndex',
    '#src/context/search/RustWorkspacePathIndex.js': 'RustWorkspacePathIndex',
    '#src/editing/proposals/EditProposalService.js': 'EditProposalService',
    '#src/editing/reviews/ProposalReviewManager.js': 'ProposalReviewManager',
    '#src/editing/reviews/persistence/FileProposalReviewStore.js': 'FileProposalReviewStore',
    '#src/editing/documents/JsDiffTextDiffer.js': 'JsDiffTextDiffer',
    '#src/http/FetchHttpClient.js': 'FetchHttpClient',
    '#src/observability/FileLogger.js': 'FileLogger',
    '#src/interaction/questions/ProposeQuestionToolRuntime.js': 'ProposeQuestionToolRuntime',
    '#src/project/ProjectAccess.js': 'ProjectAccess',
    '#src/project/ProjectToolRuntime.js': 'ProjectToolRuntime',
    '#src/providers/openai/OpenAIModelCatalog.js': 'OpenAIModelCatalog',
    '#src/providers/openai/OpenAIBackend.js': 'OpenAIBackend',
    '#src/providers/openai/OpenAIProviderFactory.js': 'OpenAIProviderFactory',
    '#src/providers/openai/auth/OpenAIAuthenticationClient.js': 'OpenAIAuthenticationClient',
    '#src/providers/openai/auth/OpenAISession.js': 'OpenAISession',
    '#src/providers/openai/auth/FileOpenAIAccountStore.js': 'FileOpenAIAccountStore',
    '#src/terminal/ui/proposal/TerminalEditReviewer.js': 'TerminalEditReviewer',
    '#src/tools/ToolRegistry.js': 'ToolRegistry',
    '#src/workspace/FileSystemWorkspaceTextStore.js': 'FileSystemWorkspaceTextStore',
    '#src/workspace/MultiRootWorkspaceTextStore.js': 'MultiRootWorkspaceTextStore',
    '#src/workspace/policy/WorkspaceAccessPolicy.js': 'WorkspaceAccessPolicy',
    '#src/shell/FileShellPermissionStore.js': 'FileShellPermissionStore',
    '#src/shell/NativeShellSandboxLauncher.js': 'NativeShellSandboxLauncher',
    '#src/shell/ShellCommandAuthorizer.js': 'ShellCommandAuthorizer',
    '#src/shell/ShellSessionManager.js': 'ShellSessionManager',
    '#src/shell/ShellToolRuntime.js': 'ShellToolRuntime',
    '#src/shell/ShellWorkingDirectoryResolver.js': 'ShellWorkingDirectoryResolver',
  };
  for (const [path, name] of Object.entries(recordedModules)) mock(path, () => ({ [name]: record(name) }));

  const settings = {
    stateDirectory: configuration.stateDirectory ?? '/state/glyph',
    traceFile: configuration.traceFile ?? '/state/glyph/trace.log',
    configuredModel: configuration.configuredModel,
    traceEnabled: true,
    openAI: { issuer: 'https://auth.example' },
    editing: { maxActiveReviews: 3 },
    contextAttachments: { maxFiles: 4 },
  };
  mock('#src/configuration/EnvironmentConfigurationProvider.js', () => ({
    EnvironmentConfigurationProvider: class {
      constructor() {
        Object.assign(this, settings);
      }
    },
  }));
  mock('#src/editing/configuration/getEditingReadBudget.js', () => ({ getEditingReadBudget: () => 1024 }));
  const assertPathIsolation = vi.fn();
  mock('#src/shell/ShellRuntimePathPolicy.js', () => ({ assertShellRuntimePathIsolation: assertPathIsolation }));
  const resolveProject = vi.fn(async (_options: unknown) => context);
  mock('#src/project/context/ProjectContextResolver.js', () => ({
    ProjectContextResolver: { resolve: resolveProject },
  }));

  const closeListeners: (() => void)[] = [];
  const closeUI = vi.fn();
  const connectShellSessions = vi.fn();
  const TerminalUIRecord = record('TerminalUI');
  mock('#src/terminal/TerminalUI.js', () => ({
    TerminalUI: class extends TerminalUIRecord {
      static readonly help = 'TERMINAL HELP';
      static clean(text: string): string {
        return text;
      }
      onClose(listener: () => void): void {
        closeListeners.push(listener);
      }
      close(): void {
        closeUI();
      }
      connectShellSessions(sessions: unknown): void {
        connectShellSessions(sessions);
      }
    },
  }));

  const active = new AbortController();
  const run = vi.fn(async (): Promise<number> => 0);
  const TerminalApplicationRecord = record('TerminalApplication');
  mock('#src/terminal/TerminalApplication.js', () => ({
    TerminalApplication: class extends TerminalApplicationRecord {
      get active(): AbortController {
        return active;
      }
      run(): Promise<number> {
        return run();
      }
    },
  }));

  let finish!: () => void;
  const finished = new Promise<void>(resolve => {
    finish = resolve;
  });
  const removeShutdownHandlers = vi.fn(() => finish());
  let installed: ShutdownOptions | undefined;
  mock('#src/terminal/installShutdownHandlers.js', () => ({
    installShutdownHandlers: (options: ShutdownOptions) => {
      installed = options;
      return removeShutdownHandlers;
    },
  }));

  let report!: (message: string) => void;
  const reported = new Promise<string>(resolve => {
    report = resolve;
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    report(String(chunk));
    return true;
  });
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  process.argv = ['node', 'glyph', ...argv];
  Object.defineProperty(process.stdin, 'isTTY', { value: interactive, configurable: true });
  onTestFinished(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalTTY) Object.defineProperty(process.stdin, 'isTTY', originalTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    for (const path of mocked) vi.doUnmock(path);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  return {
    run,
    active,
    stdout,
    reported,
    finished,
    closeUI,
    closeListeners,
    connectShellSessions,
    removeShutdownHandlers,
    resolveProject,
    assertPathIsolation,
    shutdownOptions: () => installed,
    instances: (name: string): readonly Recorded[] => recorded.get(name) ?? [],
    start: async () => {
      vi.resetModules();
      await import('#src/cli.js');
    },
  };
}

function folderContext(path: string): ProjectContext {
  return {
    id: 'project',
    mutationIdentity: 'project-root',
    kind: ProjectContextKind.FOLDER,
    name: 'Project',
    authority: 'local',
    roots: [{ name: path === repositoryRoot ? 'Repository' : 'Project', path }],
  };
}

function setPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  onTestFinished(() => {
    Object.defineProperty(process, 'platform', original);
  });
}
