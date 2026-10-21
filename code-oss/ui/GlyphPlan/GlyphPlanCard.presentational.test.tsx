import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphPlanCard } from '#code-oss/ui/GlyphPlan/GlyphPlanCard.presentational.tsx';

afterEach(cleanup);

describe(GlyphPlanCard, () => {
  it('summarizes a created plan and offers to view or build it', () => {
    const view = vi.fn();
    const build = vi.fn();
    const buildNew = vi.fn();
    render(
      <GlyphPlanCard
        plan={{
          id: 'plan',
          revision: 1,
          title: 'Ship it',
          summary: 'Everything needed to ship.',
          markdown: '',
          todos: [],
          agents: [],
        }}
        view={view}
        build={build}
        buildNew={buildNew}
        disabled={false}
      />,
    );

    const card = screen.getByRole('article', { name: 'Plan: Ship it' });
    expect(card.querySelector('small')?.textContent).toBe('Created Plan');
    expect(screen.getByRole('heading', { name: 'Ship it' })).toBeTruthy();
    expect(screen.getByText('Everything needed to ship.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View Plan' }));
    fireEvent.click(screen.getByRole('button', { name: /^Build\s*⌘↵$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Build options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build in new chat' }));

    expect(view).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledOnce();
    expect(buildNew).toHaveBeenCalledOnce();
  });

  it('still allows viewing a plan that cannot be built', () => {
    render(
      <GlyphPlanCard
        plan={{ id: 'plan', revision: 1, title: 'Ship it', summary: '', markdown: '', todos: [], agents: [] }}
        view={vi.fn()}
        build={vi.fn()}
        buildNew={vi.fn()}
        disabled
      />,
    );

    expect((screen.getByRole('button', { name: 'View Plan' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /^Build\s*⌘↵$/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
