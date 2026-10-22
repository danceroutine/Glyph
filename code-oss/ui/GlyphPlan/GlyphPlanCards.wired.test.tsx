import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { WiredGlyphPlanCards } from '#code-oss/ui/GlyphPlan/GlyphPlanCards.wired.tsx';

afterEach(cleanup);

const plan = (overrides: Partial<GlyphPlan> = {}): GlyphPlan => ({
  id: 'plan',
  revision: 1,
  title: 'Ship it',
  summary: 'Summary',
  markdown: '',
  todos: [],
  agents: [],
  ...overrides,
});

describe(WiredGlyphPlanCards, () => {
  it('views and builds each plan of the chat through the host', async () => {
    const viewPlan = vi.fn(async () => {});
    const buildPlan = vi.fn(async () => {});
    const first = plan({ id: 'one', title: 'One' });
    const second = plan({ id: 'two', title: 'Two' });
    render(
      <WiredGlyphPlanCards
        chatId="chat"
        plans={[first, second]}
        actions={{ viewPlan, buildPlan } as unknown as GlyphWorkbenchViewActions}
        disabled={false}
      />,
    );
    const card = screen.getByRole('article', { name: 'Plan: Two' });

    fireEvent.click(card.querySelector('button')!);
    await waitFor(() => {
      expect(viewPlan).toHaveBeenCalledWith('chat', second);
    });

    fireEvent.click(screen.getAllByRole('button', { name: /^Build\s*⌘↵$/u })[1]!);
    await waitFor(() => {
      expect(buildPlan).toHaveBeenCalledWith('chat', second, false);
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Build options' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Build in new chat' }));
    await waitFor(() => {
      expect(buildPlan).toHaveBeenCalledWith('chat', first, true);
    });
  });

  it('disables building while a plan action is pending or the chat is unavailable', async () => {
    const buildPlan = vi.fn(() => new Promise<void>(() => {}));
    const { rerender } = render(
      <WiredGlyphPlanCards
        chatId="chat"
        plans={[plan()]}
        actions={{ buildPlan } as unknown as GlyphWorkbenchViewActions}
        disabled={false}
      />,
    );
    const build = screen.getByRole('button', { name: /^Build\s*⌘↵$/u }) as HTMLButtonElement;

    fireEvent.click(build);
    await waitFor(() => {
      expect(build.disabled).toBe(true);
    });

    rerender(
      <WiredGlyphPlanCards
        chatId="other"
        plans={[plan()]}
        actions={{ buildPlan } as unknown as GlyphWorkbenchViewActions}
        disabled
      />,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Build\s*⌘↵$/u }).disabled).toBe(true);
  });

  it('shows why the last plan action failed', async () => {
    render(
      <WiredGlyphPlanCards
        chatId="chat"
        plans={[plan()]}
        actions={
          {
            viewPlan: vi.fn(async () => {
              throw new Error('Missing plan');
            }),
          } as unknown as GlyphWorkbenchViewActions
        }
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View Plan' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Missing plan');
  });
});
