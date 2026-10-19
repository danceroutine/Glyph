import {
  GlyphToolActivityStatus as Status,
  type GlyphToolActivity,
} from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';

export const projectToolCalls: readonly GlyphToolActivity[] = [
  {
    id: 'search',
    name: 'search_project',
    status: Status.COMPLETED,
    arguments: JSON.stringify({ query: 'message queue', limit: 10 }),
    summary: 'src/desktop/workbench/GlyphComposerState.ts\ncode-oss/ui/GlyphComposer/GlyphComposer.presentational.tsx',
    textOffset: 0,
  },
  {
    id: 'read',
    name: 'read_project_file',
    status: Status.COMPLETED,
    arguments: JSON.stringify({ path: 'src/desktop/workbench/GlyphComposerState.ts', start_line: 1, end_line: 60 }),
    summary: 'export class GlyphComposerState {\n  private queuedMessages: Message[] = [];\n}',
    textOffset: 0,
  },
  {
    id: 'tests',
    name: 'find_project_files',
    status: Status.COMPLETED,
    arguments: JSON.stringify({ pattern: '**/GlyphComposer*.test.ts' }),
    summary: 'src/desktop/workbench/tests/GlyphComposerState.test.ts',
    textOffset: 0,
  },
];
export function shellFixture(overrides: Partial<GlyphShellCommand> = {}): GlyphShellCommand {
  return {
    command: 'whoami',
    output: 'pedro\n',
    workingDirectory: '/workspace/glyph',
    sessionId: 'shell-1',
    background: false,
    live: false,
    running: false,
    ...(overrides.running ? {} : { exitCode: 0 }),
    ...structuredClone(overrides),
  };
}
export function toolActivityFixture(overrides: Partial<GlyphToolActivity> = {}): GlyphToolActivity {
  const base = projectToolCalls.find(tool => tool.name === overrides.name) ?? projectToolCalls[0]!;
  return {
    ...structuredClone(base),
    ...(overrides.status && overrides.status !== Status.COMPLETED ? { summary: '' } : {}),
    ...structuredClone(overrides),
  };
}
export function shellActivityFixture(overrides: Partial<GlyphToolActivity> = {}): GlyphToolActivity {
  return {
    id: 'call-1',
    name: 'execute_shell',
    status: Status.COMPLETED,
    shell: shellFixture(),
    ...structuredClone(overrides),
  };
}
export function runFixture(overrides: Partial<GlyphRunProjection> = {}): GlyphRunProjection {
  return {
    chatId: 'chat',
    runId: 'run',
    text: '',
    reasoning: '',
    tools: [],
    status: GlyphRunStatus.COMPLETED,
    ...structuredClone(overrides),
  };
}

export function progressFixture(
  overrides: Partial<Pick<GlyphRunProjection, 'reasoning' | 'tools' | 'status'>> = {},
): Pick<GlyphRunProjection, 'reasoning' | 'tools' | 'status'> {
  const { reasoning, tools, status } = runFixture(overrides);
  return { reasoning, tools, status };
}
