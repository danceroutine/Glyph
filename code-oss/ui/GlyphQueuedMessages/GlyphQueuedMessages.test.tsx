import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { GlyphComposerState } from '#code-oss/ui/GlyphComposer/useGlyphComposerState.ts';
import { GlyphQueuedMessages } from '#code-oss/ui/GlyphQueuedMessages/GlyphQueuedMessages.tsx';

afterEach(cleanup);

const queueState = (overrides: Record<string, unknown> = {}) => {
  const state = {
    queued: [
      { id: 'one', text: 'First message' },
      { id: 'two', text: 'Second message' },
    ],
    disabled: false,
    queueSubmitting: undefined,
    editingQueuedMessage: undefined,
    queueError: undefined,
    queuePaused: false,
    active: true,
    moveQueued: vi.fn(),
    sendQueued: vi.fn(),
    editQueued: vi.fn(),
    removeQueued: vi.fn(),
    resumeQueue: vi.fn(),
    moveQueuedToNewChat: vi.fn(),
    steerQueued: vi.fn(),
    openMessageSettings: vi.fn(),
    ...overrides,
  };
  return state as unknown as GlyphComposerState;
};

const row = (index: number) => screen.getAllByRole('listitem')[index]!;
const button = (index: number, name: string) =>
  [...row(index).querySelectorAll('button')].find(element => element.getAttribute('aria-label') === name)!;

describe(GlyphQueuedMessages, () => {
  it('renders nothing without queued messages', () => {
    const { container } = render(<GlyphQueuedMessages state={queueState({ queued: [] })} />);

    expect(container.innerHTML).toBe('');
  });

  it('lists queued messages with their actions', () => {
    const state = queueState();
    render(<GlyphQueuedMessages state={state} />);

    const toggle = screen.getByRole('button', { name: '2 Queued Messages' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list').id).toBe(toggle.getAttribute('aria-controls'));
    expect(screen.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual([
      'Queued message 1: First message',
      'Queued message 2: Second message',
    ]);
    expect(row(0).draggable).toBe(true);
    expect(Object.hasOwn(row(0).dataset, 'editing')).toBe(false);

    fireEvent.click(button(1, 'Send queued message immediately'));
    fireEvent.click(button(1, 'Edit queued message'));
    fireEvent.click(button(1, 'Remove queued message'));

    expect(state.sendQueued).toHaveBeenCalledWith('two');
    expect(state.editQueued).toHaveBeenCalledWith('two');
    expect(state.removeQueued).toHaveBeenCalledWith('two');
  });

  it('counts a single queued message in the singular', () => {
    render(<GlyphQueuedMessages state={queueState({ queued: [{ id: 'one', text: 'Only' }] })} />);

    expect(screen.getByRole('button', { name: '1 Queued Message' })).toBeTruthy();
  });

  it('collapses and expands the list', () => {
    const { container } = render(<GlyphQueuedMessages state={queueState()} />);
    const toggle = screen.getByRole('button', { name: '2 Queued Messages' });

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('[aria-hidden="true"][inert]')?.contains(screen.getByRole('list', { hidden: true })),
    ).toBe(true);

    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves a message up or down with Alt and the arrow keys', () => {
    const state = queueState();
    render(<GlyphQueuedMessages state={state} />);

    fireEvent.keyDown(row(1), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(row(0), { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(row(0), { key: 'ArrowDown' });
    fireEvent.keyDown(row(0), { key: 'Enter', altKey: true });

    expect(vi.mocked(state.moveQueued).mock.calls).toEqual([
      ['two', 0],
      ['one', 1],
    ]);
  });

  it('reorders messages by dragging', () => {
    const state = queueState();
    render(<GlyphQueuedMessages state={state} />);
    const dataTransfer = { effectAllowed: 'all', setData: vi.fn() };
    const start = new DragEvent('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(start, 'dataTransfer', { value: dataTransfer });

    row(0).dispatchEvent(start);
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    row(1).dispatchEvent(over);
    fireEvent.drop(row(1));

    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'one');
    expect(over.defaultPrevented).toBe(true);
    expect(state.moveQueued).toHaveBeenCalledWith('one', 1);
  });

  it('ignores drops that did not start from a queued message', () => {
    const state = queueState();
    render(<GlyphQueuedMessages state={state} />);
    const dataTransfer = new DataTransfer();

    fireEvent.dragStart(row(0), { dataTransfer });
    fireEvent.dragEnd(row(0));
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    row(1).dispatchEvent(over);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    row(1).dispatchEvent(drop);

    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(true);
    expect(state.moveQueued).not.toHaveBeenCalled();
  });

  it('does not start dragging from an action button', () => {
    render(<GlyphQueuedMessages state={queueState()} />);
    const start = new Event('dragstart', { bubbles: true, cancelable: true });

    button(0, 'Edit queued message').dispatchEvent(start);
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    row(1).dispatchEvent(over);

    expect(start.defaultPrevented).toBe(true);
    expect(over.defaultPrevented).toBe(false);
  });

  it('locks reordering and actions while the queue is busy', () => {
    const state = queueState({ queueSubmitting: 'one' });
    render(<GlyphQueuedMessages state={state} />);
    const dataTransfer = new DataTransfer();

    expect(row(0).draggable).toBe(false);
    fireEvent.dragStart(row(0), { dataTransfer });
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    row(1).dispatchEvent(over);
    fireEvent.drop(row(1), { dataTransfer });
    fireEvent.keyDown(row(1), { key: 'ArrowUp', altKey: true });

    expect(over.defaultPrevented).toBe(false);
    expect(state.moveQueued).not.toHaveBeenCalled();
    for (const name of [
      'Send queued message immediately',
      'Edit queued message',
      'Remove queued message',
      'Queued message actions',
    ])
      expect(button(0, name).disabled).toBe(true);
  });

  it('disables actions while the composer is disabled', () => {
    render(<GlyphQueuedMessages state={queueState({ disabled: true, queuePaused: true })} />);

    expect(button(0, 'Remove queued message').disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume queue' }).disabled).toBe(true);
  });

  it('only allows removing the message being edited', () => {
    render(<GlyphQueuedMessages state={queueState({ editingQueuedMessage: 'one' })} />);

    expect(Object.hasOwn(row(0).dataset, 'editing')).toBe(true);
    expect(button(0, 'Send queued message immediately')).toBeUndefined();
    expect(button(0, 'Edit queued message')).toBeUndefined();
    expect(button(0, 'Queued message actions')).toBeUndefined();
    expect(button(0, 'Remove queued message').disabled).toBe(false);
    expect(button(1, 'Remove queued message').disabled).toBe(true);
    expect(button(1, 'Send queued message immediately').disabled).toBe(true);
  });

  it('shows queue errors and resumes a paused queue', () => {
    const state = queueState({ queueError: 'Send failed', queuePaused: true });
    render(<GlyphQueuedMessages state={state} />);

    expect(screen.getByRole('alert').textContent).toBe('Send failed');

    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));

    expect(state.resumeQueue).toHaveBeenCalledOnce();
  });

  it('opens a menu of further actions beside its button', () => {
    const original = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'menu') return new DOMRect(0, 0, 190, 120);
      if (this.getAttribute('aria-label') === 'Queued message actions') return new DOMRect(300, 40, 24, 24);
      return original.call(this);
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
    render(<GlyphQueuedMessages state={queueState()} />);
    const more = button(1, 'Queued message actions');

    fireEvent.click(more);

    const menu = screen.getByRole('menu');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(Object.hasOwn(row(1).dataset, 'menuOpen')).toBe(true);
    expect([menu.style.left, menu.style.top]).toEqual([`${324 - 190}px`, '68px']);
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Move to New Chat',
      'Steer',
      'New Message Settings',
    ]);

    fireEvent.click(more);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the menu within the window', () => {
    const original = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.getAttribute('role') === 'menu') return new DOMRect(0, 0, 190, innerHeight);
      if (this.getAttribute('aria-label') === 'Queued message actions') return new DOMRect(0, innerHeight, 24, 24);
      return original.call(this);
    });
    onTestFinished(() => {
      spy.mockRestore();
    });
    render(<GlyphQueuedMessages state={queueState()} />);

    fireEvent.click(button(0, 'Queued message actions'));

    const menu = screen.getByRole('menu');
    expect([menu.style.left, menu.style.top]).toEqual(['8px', '8px']);
  });

  it('moves, steers or configures a queued message from its menu', () => {
    const state = queueState();
    render(<GlyphQueuedMessages state={state} />);

    fireEvent.click(button(0, 'Queued message actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to New Chat' }));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(button(1, 'Queued message actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Steer' }));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(button(1, 'Queued message actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Message Settings' }));
    expect(screen.queryByRole('menu')).toBeNull();

    expect(state.moveQueuedToNewChat).toHaveBeenCalledWith('one');
    expect(state.steerQueued).toHaveBeenCalledWith('two');
    expect(state.openMessageSettings).toHaveBeenCalledOnce();
  });

  it('cannot steer without an active turn', () => {
    render(<GlyphQueuedMessages state={queueState({ active: false })} />);

    fireEvent.click(button(0, 'Queued message actions'));

    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Steer' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Move to New Chat' }).disabled).toBe(false);
  });

  it('closes the menu on Escape, collapsing or pointing elsewhere', () => {
    render(<GlyphQueuedMessages state={queueState()} />);
    const more = button(0, 'Queued message actions');

    fireEvent.click(more);
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.pointerDown(screen.getByRole('menu'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(more, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('button', { name: '2 Queued Messages' }));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '2 Queued Messages' }));
    fireEvent.click(more);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
