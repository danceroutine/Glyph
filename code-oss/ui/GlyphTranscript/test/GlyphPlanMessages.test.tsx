import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphPlanPromptIntent, toGlyphPlanPrompt } from '#src/desktop/workbench/GlyphPlanPrompt.js';
import { WiredGlyphTranscript } from '#code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
import {
  GlyphPlanBuildMessage,
  type GlyphPlanBuildMessageProps,
} from '#code-oss/ui/GlyphTranscript/GlyphPlanBuildMessage.presentational.tsx';
import { GlyphPlanProgressRider } from '#code-oss/ui/GlyphTranscript/GlyphPlanProgressRider.presentational.tsx';
import { GlyphTodoList } from '#code-oss/ui/GlyphTodoCard/GlyphTodoList.presentational.tsx';

afterEach(cleanup);
const build = {
  planId: 'plan',
  revision: 1,
  title: 'Implement selection',
  sourceChatId: 'source',
  todos: [
    { id: 'a', text: 'Map suites', completed: true },
    { id: 'b', text: 'Run CI', completed: false },
  ],
};
const order = toGlyphPlanPrompt(GlyphPlanPromptIntent.BUILD, {
  id: build.planId,
  revision: build.revision,
  title: build.title,
  summary: '',
  markdown: 'Plan body',
  todos: build.todos,
  agents: [],
});
const message = (text: string): GlyphTranscriptEntry => ({
  id: 'build',
  role: GlyphTranscriptRole.USER,
  text,
  options: { planBuild: build },
});

describe('plan messages', () => {
  it('renders the build lead, todo states, plan navigation, and its subsequent progress', () => {
    const openPlan = vi.fn();
    render(
      <WiredGlyphTranscript
        openPlan={openPlan}
        entries={[
          message(`Keep it small.\n\n${order}`),
          {
            id: 'followup',
            role: GlyphTranscriptRole.USER,
            text: 'Keep going',
            options: {
              planProgress: { planId: 'plan', title: build.title, current: 'Run CI', completed: 1, total: 2 },
            },
          },
        ]}
      />,
    );
    expect(screen.getByText('Keep it small.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: `Build ${build.title}. Open plan` }));
    expect(openPlan).toHaveBeenCalledWith('source', 'plan');
    expect(screen.getByRole('note').textContent).toContain('Run CI');
  });

  it('pins only the latest matching build while ignoring unknown plan IDs and ordinary entries', () => {
    const entries: GlyphTranscriptEntry[] = [
      { ...message(order), id: 'old' },
      { id: 'normal', role: GlyphTranscriptRole.USER, text: 'Normal' },
      { id: 'reply', role: GlyphTranscriptRole.ASSISTANT, text: 'Answer' },
      message(order),
    ];
    const { container } = render(<WiredGlyphTranscript entries={entries} buildingPlanIds={['plan', 'missing']} />);
    expect(container.querySelectorAll('[data-building="true"]')).toHaveLength(1);
    expect(
      screen
        .getAllByRole('button', { name: `Build ${build.title}. Open plan` })
        .every(button => (button as HTMLButtonElement).disabled),
    ).toBe(true);
  });

  it.each([
    { completed: 0, total: 0 },
    { completed: 1, total: 1 },
    { completed: 0, total: 1 },
  ])('describes progress without a current task: %j', counts => {
    render(<GlyphPlanProgressRider progress={{ planId: 'plan', title: 'Build plan', ...counts }} />);
    expect(screen.getByRole('note').textContent).toContain('Build plan');
  });

  it('preserves build annotations and attachment errors when no lead or todos are present', () => {
    const entry = {
      id: 'build',
      role: GlyphTranscriptRole.USER,
      text: '',
      label: 'You',
      parts: [{ type: 'text', text: ' ' }],
      options: { annotations: [] },
      attachmentError: 'Attachment unavailable',
    } as unknown as GlyphPlanBuildMessageProps['entry'];
    render(<GlyphPlanBuildMessage entry={entry} build={{ ...build, todos: [] }} building={false} content={null} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Attachment unavailable');
  });

  it('keeps attachment-only leads visible and accepts a custom todo list class', () => {
    const entry = {
      id: 'build',
      role: GlyphTranscriptRole.USER,
      text: '',
      label: 'You',
      parts: [{ type: 'attachment' }],
    } as unknown as GlyphPlanBuildMessageProps['entry'];
    render(
      <GlyphPlanBuildMessage
        entry={entry}
        build={{ ...build, todos: [] }}
        building={false}
        content={<span>Captured context</span>}
      />,
    );
    expect(screen.getByText('Captured context')).toBeTruthy();
    const list = render(<GlyphTodoList class="custom-todos" items={[]} />);
    expect(screen.getByRole('list').className).toContain('custom-todos');
    list.rerender(<GlyphTodoList items={[]} />);
    expect(screen.getByRole('list').className).not.toContain('custom-todos');
  });
});
