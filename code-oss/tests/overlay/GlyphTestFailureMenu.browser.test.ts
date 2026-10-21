import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { MenuId } from '#vs/platform/actions/common/actions.js';
import { GlyphTestFailureMenu } from '#vs/workbench/contrib/glyph/browser/GlyphTestFailureMenu.js';

function menu(action: { id: string; label: string }) {
  const container = document.createElement('div');
  document.body.append(container);
  const run = vi.fn();
  const changeListeners = new Set<() => void>();
  const menuService = {
    createMenu: () => ({
      getActions: () => [['navigation', [{ ...action, enabled: true, run }]]],
      onDidChange: (listener: () => void) => {
        changeListeners.add(listener);
        return { dispose: () => changeListeners.delete(listener) };
      },
      dispose: () => {},
    }),
  };
  const instantiationService = {
    createInstance: (ctor: new (...args: unknown[]) => unknown, ...args: unknown[]) => new ctor(...args),
  };
  const instance = new GlyphTestFailureMenu(
    { container, menuId: MenuId.TestMessageContent, getActionArg: () => 'test message' as never },
    instantiationService as never,
    menuService as never,
    {} as never,
  );
  onTestFinished(() => {
    instance.dispose();
    container.remove();
  });
  return {
    container,
    run,
    instance,
    change: () => {
      for (const listener of changeListeners) listener();
    },
  };
}

describe(GlyphTestFailureMenu, () => {
  it('renders the Glyph fix action as a shared button that runs the action with the test message', () => {
    const { container, run } = menu({ id: 'glyph.fixTestFailure', label: 'Fix with Agent' });

    const widget = container.querySelector<HTMLElement>('.floating-click-widget');
    const button = container.querySelector('button');
    expect(container.children).toHaveLength(1);
    expect(widget?.style.padding).toBe('0px');
    expect(widget?.style.background).toContain('transparent');
    expect(widget?.style.borderWidth).toBe('0px');
    expect(button?.textContent).toContain('Fix with Agent');

    button!.click();

    expect(run).toHaveBeenCalledWith('test message');
  });

  it('removes the Glyph button when the menu changes or is disposed', () => {
    const { container, change, instance } = menu({ id: 'glyph.fixTestFailure', label: 'Fix with Agent' });
    const first = container.querySelector('.floating-click-widget');

    change();

    expect(first?.isConnected).toBe(false);
    expect(container.querySelectorAll('.floating-click-widget')).toHaveLength(1);

    instance.dispose();

    expect(container.children).toHaveLength(0);
  });

  it('renders other providers’ actions natively', () => {
    const { container, run } = menu({ id: 'other.fix', label: 'Other Fix' });

    const widget = container.querySelector<HTMLElement>('.floating-click-widget');
    expect(container.querySelector('button')).toBeNull();
    expect(widget?.textContent).toBe('Other Fix');
    expect(widget?.style.padding).toBe('6px 11px');

    widget!.click();

    expect(run).toHaveBeenCalledWith('test message');
  });
});
