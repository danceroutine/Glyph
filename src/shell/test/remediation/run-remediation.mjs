import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const commands = [
  [process.execPath, ['src/shell/test/remediation/validate-plan.mjs']],
  [
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'src/shell/test/NativeShellSandboxLauncher.test.ts',
      'src/shell/test/ShellCommandAuthorizer.test.ts',
      'src/shell/test/ShellSessionManager.test.ts',
      'src/shell/test/ShellToolRuntime.test.ts',
      'src/shell/test/ShellRuntimePathPolicy.test.ts',
      'src/observability/tests/FileLogger.test.ts',
      'src/providers/openai/tests/OpenAIProvider.test.ts',
      'src/terminal/tests/TerminalApplicationShell.test.ts',
    ],
  ],
  ['cargo', ['test', '--package', 'glyph-shell-sandbox']],
];

for (const [command, arguments_] of commands) {
  const result = spawnSync(command, arguments_, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
