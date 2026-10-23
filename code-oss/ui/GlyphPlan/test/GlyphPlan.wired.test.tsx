import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WiredGlyphPlan } from '#code-oss/ui/GlyphPlan/GlyphPlan.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphPlan, () => {
  it('renders the plan markdown and opens its links through the host', async () => {
    const openLink = vi.fn(async () => {});
    render(
      <WiredGlyphPlan
        state={{
          plan: {
            id: 'plan',
            revision: 1,
            title: 'Ship it',
            summary: 'Summary',
            markdown: '# Ship it\n\nSee [docs](https://example.com).',
            todos: [],
            agents: [],
          },
          disabled: false,
          agents: [],
        }}
        actions={{
          update: vi.fn(async () => {}),
          setTodo: vi.fn(async () => {}),
          build: vi.fn(async () => {}),
          stopBuild: vi.fn(async () => {}),
          newAgent: vi.fn(async () => {}),
          openChat: vi.fn(async () => {}),
          openLink,
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Ship it' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));

    await waitFor(() => {
      expect(openLink).toHaveBeenCalledWith('https://example.com');
    });
  });

  it('focuses the todo description when adding a todo', async () => {
    render(
      <WiredGlyphPlan
        state={{
          plan: { id: 'plan', revision: 1, title: 'Ship it', summary: '', markdown: '', todos: [], agents: [] },
          disabled: false,
          agents: [],
        }}
        actions={{
          update: vi.fn(async () => {}),
          setTodo: vi.fn(async () => {}),
          build: vi.fn(async () => {}),
          stopBuild: vi.fn(async () => {}),
          newAgent: vi.fn(async () => {}),
          openChat: vi.fn(async () => {}),
          openLink: vi.fn(async () => {}),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New todo' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Todo description' }));
    });
  });
});
