import type { GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { agentMessageFixture, usageFixture } from './MessageFixtures.ts';
import { toolActivityFixture, shellActivityFixture, shellFixture, progressFixture } from './ToolFixtures.ts';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
export function reasoningMessageFixture(): GlyphTranscriptEntry {
  return agentMessageFixture({
    id: 'progress',
    text: 'Inspecting the project.',
    progress: progressFixture({
      reasoning:
        'I will inspect the entry point, then read the relevant tests.\nThe tool results will determine the next step.',
      status: GlyphRunStatus.STREAMING,
      tools: [
        toolActivityFixture({ id: 'read', name: 'read_project_file', status: GlyphToolActivityStatus.COMPLETED }),
        toolActivityFixture({ id: 'search', name: 'search_project', status: GlyphToolActivityStatus.STARTED }),
        toolActivityFixture({ id: 'failed', name: 'read_project_file', status: GlyphToolActivityStatus.FAILED }),
      ],
    }),
  });
}
export function interruptedMessageFixture(): GlyphTranscriptEntry {
  return agentMessageFixture({
    id: 'interrupted',
    text: 'Partial answer before the host stopped.',
    progress: progressFixture({
      reasoning: 'Inspecting the file.',
      status: GlyphRunStatus.INTERRUPTED,
      tools: [toolActivityFixture({ id: 'read', name: 'read_project_file', status: GlyphToolActivityStatus.STARTED })],
    }),
  });
}
export function markdownMessageFixture(): GlyphTranscriptEntry {
  return agentMessageFixture({
    id: 'markdown-answer',
    checkpointTurnId: 'markdown-answer',
    createdAt: '2026-10-17T15:30:08Z',
    usage: usageFixture({}),
    text: '## Queue composer messages\n\nMessages remain **in order** while the agent works. See [GlyphComposerState.ts](src/desktop/workbench/GlyphComposerState.ts).\n\n1. Submit the next message.\n2. Check whether a run is active.\n   - Queue it when busy.\n   - Send it immediately when idle.\n\n> Preserve the original attachments and their exact revisions.\n\n```mermaid\nflowchart LR\n  Composer --> Active{Run active?}\n  Active -->|yes| Queue[Add to queue]\n  Active -->|no| Send[Send immediately]\n```\n\n### Verification\n\n| Check | Result |\n| --- | --- |\n| Message order | Passed |\n| Attachment revisions | Passed |\n\n```ts\nconst next = queue.shift();\nif (next) await send(next);\n```\n\nRun `pnpm test` before building.',
  });
}
export function codeMessageFixture(): GlyphTranscriptEntry {
  return agentMessageFixture({
    id: 'code-blocks',
    checkpointTurnId: 'code-blocks',
    createdAt: '2026-10-19T14:30:00Z',
    text: [
      '### Queue implementation',
      'Use the controls on each block to wrap long lines or copy the code.',
      '```ts',
      'const next = queue.shift();',
      'if (next) await send({ ...next, description: "Preserve the original attachments and their exact revisions, including when this line wraps in a narrow chat pane." });',
      '```',
      '```python',
      'def next_message(queue):',
      '    # Preserve message order.',
      '    return queue.pop(0) if queue else None',
      '```',
      '```html',
      '<button aria-label="Send message">Send</button>',
      '```',
      'Unknown and unlabelled languages remain readable:',
      '```custom-language',
      'job "send message" -> queue',
      '```',
      '```',
      'Message queued successfully.',
      '```',
    ].join('\n\n'),
  });
}
export function completeMessageFixture(): GlyphTranscriptEntry {
  return agentMessageFixture({
    text: 'The queue now preserves attachment revisions.\n\n```ts\nconst next = queue.shift();\nif (next) await send(next);\n```\n\nAll queue tests passed.',
    questionResponses: [
      {
        id: 'answers',
        answers: [
          { question: 'Which test runners should we verify?', answer: 'Vitest, node:test' },
          { question: 'Preserve the captured attachments?', answer: 'Yes' },
        ],
      },
    ],
    progress: progressFixture({
      reasoning: 'Inspect the queue, preserve the captured revisions, then run the focused tests.',
      status: GlyphRunStatus.COMPLETED,
      tools: [
        toolActivityFixture({
          id: 'search',
          name: 'search_project',
          status: GlyphToolActivityStatus.COMPLETED,
          arguments: '{"query":"queuedMessages"}',
          summary: 'Found the queue in GlyphComposerState.ts.',
        }),
        toolActivityFixture({
          id: 'read',
          name: 'read_project_file',
          status: GlyphToolActivityStatus.COMPLETED,
          arguments: '{"path":"src/desktop/workbench/GlyphComposerState.ts"}',
          summary: 'Read the composer state.',
        }),
        shellActivityFixture({
          id: 'shell',
          name: 'execute_shell',
          status: GlyphToolActivityStatus.COMPLETED,
          shell: shellFixture({
            command: 'pnpm test -- GlyphComposerState',
            output: '12 tests passed\n',
            workingDirectory: '/workspace/glyph',
            sessionId: 'shell-1',
            background: false,
            live: false,
            running: false,
            exitCode: 0,
          }),
        }),
      ],
    }),
  });
}
