import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphAgentReviewScope, type GlyphAgentReviewControls } from '#src/desktop/workbench/GlyphAgentReview.js';
import { GlyphAgentReview } from '#code-oss/ui/GlyphAgentReview/GlyphAgentReview.presentational.tsx';

afterEach(cleanup);

function reviewControls(overrides: Partial<GlyphAgentReviewControls> = {}): GlyphAgentReviewControls {
  return {
    scope: GlyphAgentReviewScope.ALL_LOCAL,
    branch: '',
    busy: false,
    chooseScope: vi.fn(),
    review: vi.fn(),
    ...overrides,
  };
}

describe(GlyphAgentReview, () => {
  it('offers to find issues in the chosen scope', () => {
    const controls = reviewControls();
    render(<GlyphAgentReview {...controls} />);

    const find = screen.getByRole('button', { name: 'Find Issues' });
    expect(screen.getByText('Review all local changes for issues.')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Review scope' }).title).toBe('Review scope: All local changes');
    expect(screen.queryByLabelText('Review findings')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(find);

    expect(controls.review).toHaveBeenCalledOnce();
  });

  it('names the branch to compare against', () => {
    const { rerender } = render(
      <GlyphAgentReview {...reviewControls({ scope: GlyphAgentReviewScope.BRANCH, branch: 'refs/heads/main' })} />,
    );
    expect(screen.getByText('Review committed changes since the common ancestor with main.')).toBeTruthy();

    rerender(
      <GlyphAgentReview
        {...reviewControls({ scope: GlyphAgentReviewScope.BRANCH, branch: 'refs/remotes/origin/dev' })}
      />,
    );
    expect(screen.getByText('Review committed changes since the common ancestor with origin/dev.')).toBeTruthy();

    rerender(<GlyphAgentReview {...reviewControls({ scope: GlyphAgentReviewScope.BRANCH, branch: '' })} />);
    expect(
      screen.getByText('Review committed changes since the common ancestor with the selected branch.'),
    ).toBeTruthy();
  });

  it('chooses a scope from the scope menu', () => {
    const controls = reviewControls({ scope: GlyphAgentReviewScope.STAGED });
    render(<GlyphAgentReview {...controls} />);
    const trigger = screen.getByRole('combobox', { name: 'Review scope' });

    fireEvent.click(trigger);
    const scopes = screen.getByRole('listbox', { name: 'Review scopes' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('glyph-review-scopes');
    expect(trigger.getAttribute('aria-activedescendant')).toBe('glyph-review-scopes-1');
    expect(
      within(scopes)
        .getAllByRole('option')
        .map(option => option.getAttribute('aria-label')),
    ).toEqual(['Last commit', 'Staged changes', 'All local changes', 'Compare against branch']);
    fireEvent.mouseEnter(within(scopes).getByRole('option', { name: 'Last commit' }));
    expect(trigger.getAttribute('aria-activedescendant')).toBe('glyph-review-scopes-0');
    fireEvent.click(within(scopes).getByRole('option', { name: 'Compare against branch' }));

    expect(controls.chooseScope).toHaveBeenCalledWith(GlyphAgentReviewScope.BRANCH);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });

  it('navigates and chooses scopes from the keyboard', () => {
    const controls = reviewControls({ scope: GlyphAgentReviewScope.LAST_COMMIT });
    render(<GlyphAgentReview {...controls} />);
    const trigger = screen.getByRole('combobox', { name: 'Review scope' });

    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe('glyph-review-scopes-3');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe('glyph-review-scopes-1');
    fireEvent.keyDown(trigger, { key: 'Tab' });
    fireEvent.keyDown(trigger, { key: ' ' });

    expect(controls.chooseScope).toHaveBeenCalledWith(GlyphAgentReviewScope.STAGED);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes the scope menu with Enter, Escape, the trigger or by leaving it', () => {
    const controls = reviewControls();
    render(
      <>
        <GlyphAgentReview {...controls} />
        <button>Elsewhere</button>
      </>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Review scope' });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);
    const group = trigger.parentElement!;
    fireEvent.blur(group, { relatedTarget: screen.getByRole('button', { name: 'Find Issues' }) });
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fireEvent.blur(group, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(controls.chooseScope).toHaveBeenCalledWith(GlyphAgentReviewScope.ALL_LOCAL);
  });

  it('closes the scope menu once reviewing becomes unavailable', () => {
    const { rerender } = render(<GlyphAgentReview {...reviewControls()} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Review scope' }));

    rerender(<GlyphAgentReview {...reviewControls({ busy: true })} />);
    rerender(<GlyphAgentReview {...reviewControls()} />);

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows progress while preparing a review', () => {
    render(<GlyphAgentReview {...reviewControls({ busy: true })} />);

    const find = screen.getByRole<HTMLButtonElement>('button', { name: 'Find Issues' });
    expect(find.getAttribute('aria-busy')).toBe('true');
    expect(find.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('combobox', { name: 'Review scope' }).disabled).toBe(true);
  });

  it('lets a running review be stopped', () => {
    const stop = vi.fn();
    const controls = reviewControls({ reviewing: true, stop, unavailableReason: 'Busy elsewhere' });
    render(<GlyphAgentReview {...controls} />);

    const reviewing = screen.getByRole<HTMLButtonElement>('button', { name: 'Reviewing' });
    expect(reviewing.title).toBe('Stop Review');
    expect(reviewing.disabled).toBe(false);
    expect(reviewing.querySelectorAll('svg')).toHaveLength(2);
    expect(screen.getByText('Reviewing your changes…')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(reviewing);

    expect(stop).toHaveBeenCalledOnce();
    expect(controls.review).not.toHaveBeenCalled();
  });

  it('explains why reviewing is unavailable', () => {
    render(<GlyphAgentReview {...reviewControls({ unavailableReason: 'Open a folder to review.', error: 'x' })} />);

    const find = screen.getByRole<HTMLButtonElement>('button', { name: 'Find Issues' });
    expect(find.disabled).toBe(true);
    expect(find.title).toBe('Open a folder to review.');
    expect(screen.getByRole('status').textContent).toBe('Open a folder to review.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports review errors', () => {
    render(<GlyphAgentReview {...reviewControls({ error: 'Review failed.' })} />);

    expect(screen.getByRole('alert').textContent).toBe('Review failed.');
  });

  it('lists findings by file while still reviewing', () => {
    const controls = reviewControls({
      reviewing: true,
      stop: vi.fn(),
      findings: [{ id: 'f1', path: 'src/a.ts', line: 1, title: 'Null check', body: 'b' }],
    });
    render(<GlyphAgentReview {...controls} />);

    const findings = screen.getByLabelText('Review findings');
    expect(within(findings).getByText('Found 1 Potential Issues')).toBeTruthy();
    expect(within(findings).getByTitle('src/a.ts').textContent).toBe('src/a.ts');
  });

  it('acts on individual findings once complete', () => {
    const controls = reviewControls({
      completed: true,
      resultScope: 'Staged changes',
      fileIconClasses: path => [`icon-${path.replaceAll('/', '-')}`],
      findings: [
        { id: 'f1', path: 'src/a.ts', line: 1, title: 'Null check', body: 'b' },
        { id: 'f2', path: 'src/b.ts', line: 2, title: 'Leak', body: 'b' },
        { id: 'f3', path: 'src/a.ts', line: 9, title: 'Typo', body: 'b' },
      ],
      openFinding: vi.fn(),
      fixFinding: vi.fn(),
      dismissFinding: vi.fn(),
      fixAll: vi.fn(),
    });
    render(<GlyphAgentReview {...controls} />);

    const findings = screen.getByLabelText('Review findings');
    expect(within(findings).getByText('Found 3 Potential Issues (Staged changes)')).toBeTruthy();
    const files = [...findings.querySelectorAll('section')];
    expect(files.map(file => file.querySelector('[title]')!.getAttribute('title'))).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0]!.querySelector('.icon-src-a\\.ts')).not.toBeNull();
    expect(within(files[0]!).getAllByRole('button', { name: /^Dismiss/u })).toHaveLength(2);
    expect(screen.queryByText(/Review .* for issues/u)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Leak' }));
    fireEvent.click(within(files[1]!).getByRole('button', { name: 'Fix' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Typo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix All Issues' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Again' }));

    expect(controls.openFinding).toHaveBeenCalledWith('f2');
    expect(controls.fixFinding).toHaveBeenCalledWith('f2');
    expect(controls.dismissFinding).toHaveBeenCalledWith('f3');
    expect(controls.fixAll).toHaveBeenCalledOnce();
    expect(controls.review).toHaveBeenCalledOnce();
  });

  it('tolerates hosts that cannot act on findings', () => {
    render(
      <GlyphAgentReview
        {...reviewControls({
          completed: true,
          findings: [{ id: 'f1', path: 'README.md', line: 1, title: 'Wording', body: 'b' }],
        })}
      />,
    );

    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Wording' }));
      fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss Wording' }));
    }).not.toThrow();
  });

  it('reports a clean review and disables fixing', () => {
    render(<GlyphAgentReview {...reviewControls({ completed: true })} />);

    expect(screen.getByText('No issues found')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Fix All Issues' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review Again' }).disabled).toBe(false);
  });

  it('disables follow-up actions while busy', () => {
    render(
      <GlyphAgentReview
        {...reviewControls({
          completed: true,
          busy: true,
          findings: [{ id: 'f1', path: 'a.ts', line: 1, title: 'Issue', body: 'b' }],
        })}
      />,
    );

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Fix All Issues' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Review Again' }).disabled).toBe(true);
  });
});
