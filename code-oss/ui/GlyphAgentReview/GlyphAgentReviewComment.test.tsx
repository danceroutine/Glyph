import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphAgentReviewComment } from '#code-oss/ui/GlyphAgentReview/GlyphAgentReviewComment.tsx';

afterEach(cleanup);

describe(GlyphAgentReviewComment, () => {
  it('presents a finding with actions to fix or dismiss it', () => {
    const fix = vi.fn();
    const dismiss = vi.fn();
    render(
      <GlyphAgentReviewComment
        finding={{ id: 'f1', path: 'src/a.ts', line: 3, title: 'Missing null check', body: 'Guard the value.' }}
        fix={fix}
        dismiss={dismiss}
      />,
    );

    const comment = screen.getByRole('region', { name: 'Agent review comment' });
    expect(comment.querySelector('strong')!.textContent).toBe('Missing null check');
    expect(comment.querySelector('p')!.textContent).toBe('Guard the value.');
    fireEvent.click(screen.getByRole('button', { name: 'Fix with Agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(fix).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
