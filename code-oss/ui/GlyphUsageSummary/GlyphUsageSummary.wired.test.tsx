import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { WiredGlyphUsageSummary } from '#code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.wired.tsx';

afterEach(cleanup);

const placeElements = (trigger: DOMRect, popup: DOMRect) => {
  const original = Element.prototype.getBoundingClientRect;
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'dialog') return popup;
    if (this.getAttribute('aria-label')?.endsWith('token usage')) return trigger;
    return original.call(this);
  });
  onTestFinished(() => spy.mockRestore());
};

describe(WiredGlyphUsageSummary, () => {
  it('opens above its trigger when there is room', () => {
    placeElements(new DOMRect(100, 400, 60, 24), new DOMRect(0, 0, 290, 200));
    render(<WiredGlyphUsageSummary usage={undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Conversation token usage' }));

    const dialog = screen.getByRole('dialog');
    expect([dialog.style.left, dialog.style.top]).toEqual(['100px', '192px']);
  });

  it('opens below its trigger and within the window when there is no room above', () => {
    placeElements(new DOMRect(innerWidth - 20, 50, 20, 24), new DOMRect(0, 0, 290, 200));
    render(<WiredGlyphUsageSummary usage={undefined} turn />);

    fireEvent.click(screen.getByRole('button', { name: 'Turn token usage' }));

    const dialog = screen.getByRole('dialog');
    expect([dialog.style.left, dialog.style.top]).toEqual([
      `${innerWidth - 290 - 8}px`,
      `${Math.max(8, Math.min(innerHeight - 200 - 8, 82))}px`,
    ]);
  });

  it('stays within the top of the window', () => {
    placeElements(new DOMRect(0, 0, 20, 0), new DOMRect(0, 0, 290, innerHeight + 100));
    render(<WiredGlyphUsageSummary usage={undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Conversation token usage' }));

    const dialog = screen.getByRole('dialog');
    expect([dialog.style.left, dialog.style.top]).toEqual(['8px', '8px']);
  });

  it('stays open when interacting with its trigger or popup', () => {
    render(<WiredGlyphUsageSummary usage={undefined} />);
    const trigger = screen.getByRole('button', { name: 'Conversation token usage' });
    fireEvent.click(trigger);

    fireEvent.pointerDown(screen.getByRole('dialog'));
    fireEvent.pointerDown(trigger);
    fireEvent.keyDown(document, { key: 'Enter' });

    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes when the pointer goes down elsewhere', () => {
    render(<WiredGlyphUsageSummary usage={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation token usage' }));

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape without letting it reach other handlers and refocuses its trigger', () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    onTestFinished(() => document.removeEventListener('keydown', outer));
    render(<WiredGlyphUsageSummary usage={undefined} />);
    const trigger = screen.getByRole('button', { name: 'Conversation token usage' });
    fireEvent.click(trigger);

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when the window resizes', () => {
    render(<WiredGlyphUsageSummary usage={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation token usage' }));

    fireEvent(window, new Event('resize'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when anything scrolls', () => {
    render(<WiredGlyphUsageSummary usage={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation token usage' }));

    fireEvent.scroll(document.body);

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
