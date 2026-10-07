import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ChatHistory } from '../ChatHistory.presentational.tsx';

describe(ChatHistory, () => {
  it('replays saved turns with live chat bubbles and collapsed reasoning', () => {
    const view = render(
      <ChatHistory
        summary={{
          schemaVersion: 2,
          id: 'chat-123456',
          title: 'Saved work',
          titleOrigin: 'human',
          projectContextId: 'project',
          accountClientId: 'client',
          accountSubject: 'subject',
          modelSlug: 'model',
          modelName: 'Model',
          createdAt: '2026-10-06T00:00:00.000Z',
          updatedAt: '2026-10-06T00:00:01.000Z',
          turnCount: 2,
        }}
        transcript={[
          {
            userText: 'Inspect @examples/todo-app/src/App.tsx',
            attachmentPaths: ['examples/todo-app/src/App.tsx'],
            reasoningSummary: '**Checking context**',
            assistantText: 'Saved answer',
            createdAt: '2026-10-06T00:00:00.000Z',
          },
          {
            userText: 'Follow up',
            attachmentPaths: [],
            reasoningSummary: '',
            assistantText: 'Second answer',
            createdAt: '2026-10-06T00:00:01.000Z',
          },
        ]}
        promptWidth={64}
      />,
    );

    const rendered = stripVTControlCharacters(view.lastFrame() ?? '');
    const promptLine = rendered.split('\n').find(line => line.includes('Inspect'))!;
    expect(rendered).toContain('Chat chat-123  Saved work  · model');
    expect(promptLine.search(/\S/u)).toBeGreaterThan(10);
    expect(promptLine).toContain('Inspect @App.tsx');
    expect(rendered).toContain('Saved answer');
    expect(rendered).toContain('Second answer');
    expect(rendered).toContain('╭');
    expect(rendered).not.toContain('thinking>');
    expect(rendered).not.toContain('assistant>');
    view.unmount();
  });
});
