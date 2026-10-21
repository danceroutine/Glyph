import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import {
  Button,
  ButtonAppearance,
  ButtonSize,
  ButtonVariant,
  IconButton,
  IconButtonShape,
} from '#code-oss/ui/Button/Button.tsx';
import { tokens } from '#code-oss/ui/design-system/index.ts';

afterEach(cleanup);

describe(Button, () => {
  it('renders a medium filled secondary button by default', () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.dataset.variant).toBe(ButtonVariant.SECONDARY);
    expect(button.dataset.appearance).toBe(ButtonAppearance.FILLED);
    expect(button.dataset.size).toBe(ButtonSize.MEDIUM);
    expect(button.style.getPropertyValue('--button-fill')).toBe(tokens.button.secondary.background);
    expect(button.style.getPropertyValue('--button-tint')).toBe(tokens.button.quiet.hoverBackground);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  it('uses the palette of the current agent mode for primary actions', () => {
    render(
      <Button variant={ButtonVariant.PRIMARY} mode={AgentModeID.PLAN}>
        Build
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Build' });
    expect(button.style.getPropertyValue('--button-fill')).toBe(tokens.text.warning);
    expect(button.style.getPropertyValue('--button-foreground')).toBe('#181818');
    expect(button.style.getPropertyValue('--button-tint')).toBe(
      `color-mix(in srgb, ${tokens.text.warning} 16%, transparent)`,
    );
  });

  it('uses the keep palette for confirming actions', () => {
    render(<Button variant={ButtonVariant.CONFIRM}>Keep</Button>);

    const button = screen.getByRole('button', { name: 'Keep' });
    expect(button.style.getPropertyValue('--button-fill')).toBe(tokens.review.keepBackground);
    expect(button.style.getPropertyValue('--button-foreground')).toBe(tokens.review.keepForeground);
    expect(button.style.getPropertyValue('--button-hover')).toBe(tokens.review.keepBackground);
  });

  it('shows its leading icon, shortcut and trailing icon around the label', () => {
    render(
      <Button
        class="custom"
        type="submit"
        leadingIcon={<i data-testid="leading" />}
        trailingIcon={<i data-testid="trailing" />}
        shortcut="⌘K"
        style={{ color: 'red' }}
      >
        Run
      </Button>,
    );

    const button = screen.getByRole('button', { name: /Run/ });
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.classList.contains('custom')).toBe(true);
    expect(button.style.color).toBe('red');
    expect(screen.getByTestId('leading')).toBeTruthy();
    expect(screen.getByTestId('trailing')).toBeTruthy();
    expect(button.querySelector('kbd')?.textContent).toBe('⌘K');
  });

  it('becomes busy and unavailable while loading', () => {
    render(
      <Button loading leadingIcon={<i data-testid="leading" />}>
        Load
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Load' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('leading')).toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
  });

  it('spins a custom glyph while loading', () => {
    render(
      <Button loading loadingIcon={<i data-testid="spinner" />}>
        Load
      </Button>,
    );

    expect(screen.getByTestId('spinner')).toBeTruthy();
  });

  it('exposes the rendered element through its button reference', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button buttonRef={ref}>Focus</Button>);

    expect(ref.current).toBe(screen.getByRole('button', { name: 'Focus' }));
  });

  it('reports clicks', () => {
    const click = vi.fn();
    render(<Button onClick={click}>Go</Button>);

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(click).toHaveBeenCalledOnce();
  });
});

describe(IconButton, () => {
  it('renders a square ghost icon button by default', () => {
    render(
      <IconButton aria-label="Close">
        <i data-testid="icon" />
      </IconButton>,
    );

    const button = screen.getByRole('button', { name: 'Close' });
    expect(button.dataset.shape).toBe(IconButtonShape.SQUARE);
    expect(button.dataset.appearance).toBe(ButtonAppearance.GHOST);
    expect(button.hasAttribute('data-icon-button')).toBe(true);
    expect(button.style.getPropertyValue('--button-icon-size')).toBe('');
    expect(screen.getByTestId('icon')).toBeTruthy();
  });

  it('sizes its icon and keeps caller styles', () => {
    render(
      <IconButton
        aria-label="Expand"
        shape={IconButtonShape.CIRCLE}
        appearance={ButtonAppearance.OUTLINE}
        iconSize={14}
        style={{ color: 'blue' }}
      >
        <i />
      </IconButton>,
    );

    const button = screen.getByRole('button', { name: 'Expand' });
    expect(button.dataset.shape).toBe(IconButtonShape.CIRCLE);
    expect(button.dataset.appearance).toBe(ButtonAppearance.OUTLINE);
    expect(button.style.getPropertyValue('--button-icon-size')).toBe('14px');
    expect(button.style.color).toBe('blue');
  });

  it('replaces its icon with a spinner while loading', () => {
    render(
      <IconButton aria-label="Refresh" loading>
        <i data-testid="icon" />
      </IconButton>,
    );

    expect(screen.queryByTestId('icon')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' }).getAttribute('aria-busy')).toBe('true');
  });
});
