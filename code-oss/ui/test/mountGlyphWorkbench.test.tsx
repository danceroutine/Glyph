import { act, cleanup, fireEvent, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphAgentReviewScope } from '#src/desktop/workbench/GlyphAgentReview.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphWorkbenchState } from '#src/desktop/tests/fixtures/aGlyphWorkbenchState.ts';
import {
  mountGlyphAgentReview,
  mountGlyphAgentReviewComment,
  mountGlyphAgentInstructions,
  mountGlyphCommentButton,
  mountGlyphContextButton,
  mountGlyphEditorAnnotationMarker,
  mountGlyphPlan,
  mountGlyphReview,
  mountGlyphWorkbench,
} from '#code-oss/ui/mountGlyphWorkbench.tsx';

afterEach(cleanup);

const host = () => {
  const container = document.createElement('div');
  document.body.append(container);
  onTestFinished(() => {
    container.remove();
  });
  return container;
};

const workbench = aGlyphWorkbenchState;

const workbenchActions = (overrides: Partial<GlyphWorkbenchViewActions> = {}): GlyphWorkbenchViewActions =>
  ({
    composer: new GlyphComposerState(),
    context: {
      selectFiles: vi.fn(async () => []),
      searchFiles: vi.fn(async () => []),
      captureFile: vi.fn(),
      openAttachment: vi.fn(async () => {}),
      refreshAttachment: vi.fn(),
      checkAttachment: vi.fn(async () => undefined),
    },
    send: vi.fn(async () => {}),
    cancel: vi.fn(),
    newChat: vi.fn(),
    openChat: vi.fn(async () => {}),
    selectModel: vi.fn(async () => {}),
    selectAccount: vi.fn(async () => {}),
    stopShell: vi.fn(async () => {}),
    ...overrides,
  }) as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;

describe(mountGlyphWorkbench, () => {
  it('renders the workbench with host file icons and follows updates until disposed', () => {
    const container = host();
    const fileIconClasses = vi.fn(() => ['file-icon']);
    const view = mountGlyphWorkbench(container, workbench(), workbenchActions({ fileIconClasses }));

    expect(screen.getByRole('tab', { name: 'New chat' })).toBeTruthy();

    act(() => {
      view.update(
        workbench({
          selectedChatId: 'chat',
          chats: [
            {
              id: 'chat',
              title: 'Refactor parser',
              accountProvider: 'openai',
              accountId: 'account',
              modelSlug: 'gpt-5',
              updatedAt: '2026-01-01T00:00:00.000Z',
              turnCount: 1,
            },
          ],
        }),
      );
    });
    expect(screen.getByRole('tab', { name: 'Refactor parser' })).toBeTruthy();

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');

    act(() => {
      view.update(workbench());
    });
    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe(mountGlyphReview, () => {
  it('renders review controls that follow updates until disposed', () => {
    const container = host();
    const controls = {
      label: '1 of 2',
      disabled: false,
      keepDisabled: false,
      previous: vi.fn(),
      next: vi.fn(),
      keep: vi.fn(async () => {}),
      undo: vi.fn(async () => {}),
    };
    const view = mountGlyphReview(container, controls);
    expect(screen.getByText('1 of 2')).toBeTruthy();

    act(() => {
      view.update({ ...controls, label: '2 of 2' });
    });
    expect(screen.getByText('2 of 2')).toBeTruthy();

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe(mountGlyphPlan, () => {
  it('renders a plan that follows updates until disposed', () => {
    const container = host();
    const plan = { id: 'plan', revision: 1, title: 'Ship it', summary: '', markdown: '', todos: [], agents: [] };
    const actions = {
      update: vi.fn(async () => {}),
      setTodo: vi.fn(async () => {}),
      build: vi.fn(async () => {}),
      stopBuild: vi.fn(async () => {}),
      newAgent: vi.fn(async () => {}),
      openChat: vi.fn(async () => {}),
      openLink: vi.fn(async () => {}),
    };
    const view = mountGlyphPlan(container, { plan, disabled: false, agents: [] }, actions);
    expect(screen.getByRole('heading', { name: '0 To-dos' })).toBeTruthy();

    act(() => {
      view.update({
        plan: { ...plan, todos: [{ id: 't', text: 'Do it', completed: false }] },
        disabled: false,
        agents: [],
      });
    });
    expect(screen.getByRole('heading', { name: '1 To-dos' })).toBeTruthy();

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe(mountGlyphCommentButton, () => {
  it('renders a selection comment button with its shortcut until disposed', () => {
    const container = host();
    const open = vi.fn();
    const view = mountGlyphCommentButton(container, open, undefined, '⌘K');
    const button = screen.getByRole('button', { name: 'Comment on selection' });

    fireEvent.click(button);

    expect(open).toHaveBeenCalledOnce();
    expect(button.querySelector('kbd')?.textContent).toBe('⌘K');

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });

  it('renders a selection comment button without a shortcut', () => {
    const container = host();
    mountGlyphCommentButton(container, vi.fn());

    expect(screen.getByRole('button', { name: 'Comment on selection' }).querySelector('kbd')).toBeNull();
  });

  it('renders a numbered annotation button', () => {
    const container = host();
    mountGlyphCommentButton(container, vi.fn(), 2);

    expect(screen.getByRole('button', { name: 'Edit annotation 2' }).textContent).toBe('2');
  });
});

describe(mountGlyphEditorAnnotationMarker, () => {
  it('renders an annotation marker until disposed', () => {
    const container = host();
    const open = vi.fn();
    const view = mountGlyphEditorAnnotationMarker(container, 3, 'Rename this', open);
    const marker = screen.getByRole('button', { name: 'Edit annotation 3' });

    fireEvent.click(marker);

    expect(marker.getAttribute('title')).toBe('Rename this');
    expect(open).toHaveBeenCalledOnce();

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe(mountGlyphContextButton, () => {
  it('renders a secondary context action that keeps editor focus', () => {
    const container = host();
    const action = vi.fn();
    const view = mountGlyphContextButton(container, 'Add to chat', action);
    const button = screen.getByRole('button', { name: 'Add to chat' });

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    fireEvent.click(button);

    expect(down.defaultPrevented).toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(button.dataset.variant).toBe('secondary');
    expect(button.dataset.appearance).toBe('outline');

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });

  it('renders a primary context action with its shortcut', () => {
    const container = host();
    mountGlyphContextButton(container, 'Comment', vi.fn(), true, '⌘L');

    const button = screen.getByRole('button', { name: /Comment/u });
    expect(button.dataset.variant).toBe('primary');
    expect(button.dataset.appearance).toBe('filled');
    expect(button.querySelector('kbd')?.textContent).toBe('⌘L');
  });
});

describe(mountGlyphAgentReview, () => {
  it('renders agent review controls that follow updates until disposed', () => {
    const container = host();
    const controls = {
      scope: GlyphAgentReviewScope.STAGED,
      branch: 'main',
      busy: false,
      chooseScope: vi.fn(),
      review: vi.fn(),
    };
    const view = mountGlyphAgentReview(container, controls);
    expect(container.textContent).not.toContain('Review failed');

    act(() => {
      view.update({ ...controls, error: 'Review failed' });
    });
    expect(container.textContent).toContain('Review failed');

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe(mountGlyphAgentReviewComment, () => {
  it('renders a review finding with fix and dismiss actions until disposed', () => {
    const container = host();
    const fix = vi.fn();
    const dismiss = vi.fn();
    const view = mountGlyphAgentReviewComment(
      container,
      { id: 'finding', path: 'a.ts', line: 1, title: 'Off by one', body: 'The loop skips the last item.' },
      fix,
      dismiss,
    );

    expect(screen.getByRole('region', { name: 'Agent review comment' }).textContent).toContain('Off by one');
    fireEvent.click(screen.getByRole('button', { name: 'Fix with Agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(fix).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();

    act(() => {
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});

describe(mountGlyphAgentInstructions, () => {
  it('renders instruction sources, follows updates, and ignores work after disposal', () => {
    const container = host();
    const openSource = vi.fn();
    const root = {
      id: 'root',
      kind: 'agents_md' as const,
      label: 'AGENTS.md',
      path: 'AGENTS.md',
      scope: '.',
      status: 'active' as const,
    };
    const nested = { ...root, id: 'nested', path: 'src/AGENTS.md', scope: 'src' };
    const view = mountGlyphAgentInstructions(container, [root], '', openSource);

    expect(screen.getByTitle('Open AGENTS.md')).toBeTruthy();
    act(() => {
      view.update([root, nested], 'src/');
    });
    fireEvent.click(screen.getByTitle('Open src/AGENTS.md'));
    expect(openSource).toHaveBeenCalledWith(nested);

    act(() => {
      view.dispose();
      view.update([root], '');
      view.dispose();
    });
    expect(container.innerHTML).toBe('');
  });
});
