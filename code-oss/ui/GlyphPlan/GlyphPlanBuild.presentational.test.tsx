import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphPlanBuild } from '#code-oss/ui/GlyphPlan/GlyphPlanBuild.presentational.tsx';

afterEach(cleanup);

describe(GlyphPlanBuild, () => {
  it('builds here or in a new chat', () => {
    const build = vi.fn();
    const buildNew = vi.fn();
    render(<GlyphPlanBuild build={build} buildNew={buildNew} disabled={false} />);

    const primary = screen.getByRole('button', { name: /^Build\s*⌘↵$/u });
    expect(primary.querySelector('kbd')?.textContent).toBe('⌘↵');
    fireEvent.click(primary);
    fireEvent.click(screen.getByRole('button', { name: 'Build options' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build in new chat' }));

    expect(build).toHaveBeenCalledOnce();
    expect(buildNew).toHaveBeenCalledOnce();
  });

  it('cannot build while disabled', () => {
    render(<GlyphPlanBuild build={vi.fn()} buildNew={vi.fn()} disabled />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Build\s*⌘↵$/u }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Build options' }).disabled).toBe(true);
  });
});
