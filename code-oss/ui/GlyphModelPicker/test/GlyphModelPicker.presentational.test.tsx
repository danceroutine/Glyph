import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphModelPicker } from '#code-oss/ui/GlyphModelPicker/GlyphModelPicker.presentational.tsx';

afterEach(cleanup);

describe(GlyphModelPicker, () => {
  it('shows the current model on a collapsed combobox', () => {
    render(
      <GlyphModelPicker
        model="o3"
        label="o3"
        disabled={false}
        models={[{ value: 'o3', label: 'o3' }]}
        selectModel={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger.textContent).toBe('o3');
    expect(trigger.getAttribute('title')).toBe('o3');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('lists the models with the current one selected and chooses another', () => {
    const selectModel = vi.fn();
    render(
      <GlyphModelPicker
        model="o3"
        label="o3"
        disabled={false}
        models={[
          { value: 'gpt-5', label: 'GPT-5' },
          { value: 'o3', label: 'o3' },
        ]}
        selectModel={selectModel}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });

    fireEvent.click(trigger);

    const listbox = screen.getByRole('listbox', { name: 'Models' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(listbox.id);
    expect(trigger.getAttribute('aria-activedescendant')).toBe(`${listbox.id}-1`);
    expect(screen.getByRole('option', { name: 'o3' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: 'GPT-5' }));

    expect(selectModel).toHaveBeenCalledWith('gpt-5');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('has no active option when there are no models', () => {
    render(<GlyphModelPicker model="" label="None" disabled={false} models={[]} selectModel={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Model' });

    fireEvent.click(trigger);

    expect(screen.getByRole('listbox', { name: 'Models' })).toBeTruthy();
    expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('closes when the picker loses focus to something outside it', () => {
    const { container } = render(
      <>
        <GlyphModelPicker
          model="o3"
          label="o3"
          disabled={false}
          models={[{ value: 'o3', label: 'o3' }]}
          selectModel={vi.fn()}
        />
        <button type="button">Elsewhere</button>
      </>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.click(trigger);

    fireEvent.blur(container.querySelector('.glyph-model-picker')!, {
      relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }),
    });

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens from the keyboard', () => {
    render(
      <GlyphModelPicker
        model="o3"
        label="o3"
        disabled={false}
        models={[{ value: 'o3', label: 'o3' }]}
        selectModel={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Model' }), { key: 'ArrowDown' });

    expect(screen.getByRole('listbox', { name: 'Models' })).toBeTruthy();
  });

  it('finds models by name when typing ahead', () => {
    render(
      <GlyphModelPicker
        model="o3"
        label="o3"
        disabled={false}
        models={[
          { value: 'o3', label: 'o3' },
          { value: 'gpt-5', label: 'GPT-5' },
        ]}
        selectModel={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });

    fireEvent.keyDown(trigger, { key: 'g' });

    const listbox = screen.getByRole('listbox', { name: 'Models' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(`${listbox.id}-1`);
  });

  it('cannot be opened while disabled', () => {
    render(
      <GlyphModelPicker model="o3" label="o3" disabled models={[{ value: 'o3', label: 'o3' }]} selectModel={vi.fn()} />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' }) as HTMLButtonElement;

    fireEvent.click(trigger);

    expect(trigger.disabled).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
