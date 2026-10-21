import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { Button, ButtonAppearance, ButtonSize, ButtonVariant, IconButton } from '#code-oss/ui/Button/Button.tsx';
import { SplitButton, SplitButtonGroup } from '#code-oss/ui/Button/SplitButton.tsx';

afterEach(cleanup);

describe(SplitButtonGroup, () => {
  it('styles its trigger like the primary action', () => {
    render(
      <SplitButtonGroup>
        <Button
          variant={ButtonVariant.PRIMARY}
          appearance={ButtonAppearance.OUTLINE}
          mode={AgentModeID.PLAN}
          size={ButtonSize.LARGE}
        >
          Build
        </Button>
        <IconButton aria-label="More">
          <i />
        </IconButton>
      </SplitButtonGroup>,
    );

    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger.dataset.variant).toBe(ButtonVariant.PRIMARY);
    expect(trigger.dataset.appearance).toBe(ButtonAppearance.OUTLINE);
    expect(trigger.dataset.size).toBe(ButtonSize.LARGE);
    expect(trigger.style.getPropertyValue('--button-foreground')).toBe('#181818');
  });

  it('styles its trigger with default button styling when the primary action has none', () => {
    render(
      <SplitButtonGroup>
        <Button>Run</Button>
        <IconButton aria-label="More">
          <i />
        </IconButton>
      </SplitButtonGroup>,
    );

    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger.dataset.variant).toBe(ButtonVariant.SECONDARY);
    expect(trigger.dataset.appearance).toBe(ButtonAppearance.FILLED);
    expect(trigger.dataset.size).toBe(ButtonSize.MEDIUM);
  });

  it('leaves arbitrary segments untouched and exposes its group element', () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <SplitButtonGroup fullWidth groupRef={ref} data-testid="group">
        <span>One</span>
        <IconButton aria-label="More" appearance={ButtonAppearance.OUTLINE}>
          <i />
        </IconButton>
      </SplitButtonGroup>,
    );

    expect(ref.current).toBe(screen.getByTestId('group'));
    expect(screen.getByRole('button', { name: 'More' }).dataset.appearance).toBe(ButtonAppearance.OUTLINE);
  });
});

describe(SplitButton, () => {
  it('opens its options and focuses the first available option', () => {
    render(
      <SplitButton
        menuLabel="Run options"
        menu={
          <>
            <button disabled>Unavailable</button>
            <button>Run all</button>
          </>
        }
      >
        Run
      </SplitButton>,
    );

    const toggle = screen.getByRole('button', { name: 'Run options' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: 'Run options' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run all' }));
    expect(toggle.dataset.variant).toBe(ButtonVariant.SECONDARY);
    expect(toggle.dataset.size).toBe(ButtonSize.MEDIUM);
    expect(toggle.dataset.appearance).toBe(ButtonAppearance.FILLED);
  });

  it('matches the trigger to the configured action styling', () => {
    render(
      <SplitButton
        menuLabel="Options"
        menu={<button>Option</button>}
        variant={ButtonVariant.PRIMARY}
        mode={AgentModeID.PLAN}
        size={ButtonSize.SMALL}
        appearance={ButtonAppearance.OUTLINE}
      >
        Run
      </SplitButton>,
    );

    const toggle = screen.getByRole('button', { name: 'Options' });
    expect(toggle.dataset.variant).toBe(ButtonVariant.PRIMARY);
    expect(toggle.dataset.size).toBe(ButtonSize.SMALL);
    expect(toggle.dataset.appearance).toBe(ButtonAppearance.OUTLINE);
    expect(toggle.style.getPropertyValue('--button-foreground')).toBe('#181818');
  });

  it('opens even when no option is available to focus', () => {
    render(
      <SplitButton menuLabel="Options" menu={<span>Nothing here</span>}>
        Run
      </SplitButton>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Options' }));

    expect(screen.getByText('Nothing here')).toBeTruthy();
  });

  it('closes when the pointer goes down outside of it', () => {
    render(
      <SplitButton menuLabel="Options" menu={<button>Option</button>}>
        Run
      </SplitButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Option' }));
    expect(screen.queryByRole('group', { name: 'Options' })).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull();
  });

  it('closes on Escape and returns focus to its toggle', () => {
    render(
      <SplitButton menuLabel="Options" menu={<button>Option</button>}>
        Run
      </SplitButton>,
    );
    const toggle = screen.getByRole('button', { name: 'Options' });
    fireEvent.click(toggle);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Option' }), { key: 'ArrowDown' });
    expect(screen.queryByRole('group', { name: 'Options' })).not.toBeNull();
    const escape = fireEvent.keyDown(screen.getByRole('button', { name: 'Option' }), { key: 'Escape' });

    expect(escape).toBe(false);
    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('ignores Escape while closed', () => {
    render(
      <SplitButton menuLabel="Options" menu={<button>Option</button>}>
        Run
      </SplitButton>,
    );

    const escape = fireEvent.keyDown(screen.getByRole('button', { name: 'Run' }), { key: 'Escape' });

    expect(escape).toBe(true);
  });

  it('closes after an option is chosen but not after clicking elsewhere in the menu', () => {
    const choose = vi.fn();
    render(
      <SplitButton
        menuLabel="Options"
        menu={
          <>
            <p>Pick one</p>
            <button onClick={choose}>Option</button>
          </>
        }
      >
        Run
      </SplitButton>,
    );
    const toggle = screen.getByRole('button', { name: 'Options' });
    fireEvent.click(toggle);

    fireEvent.click(screen.getByText('Pick one'));
    expect(screen.queryByRole('group', { name: 'Options' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Option' }));

    expect(choose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('toggles closed from its trigger', () => {
    render(
      <SplitButton menuLabel="Options" menu={<button>Option</button>}>
        Run
      </SplitButton>,
    );
    const toggle = screen.getByRole('button', { name: 'Options' });

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull();
  });

  it('closes and disables its options while the action is disabled or loading', () => {
    const { rerender } = render(
      <SplitButton menuLabel="Options" menu={<button>Option</button>}>
        Run
      </SplitButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Options' }));

    rerender(
      <SplitButton menuLabel="Options" menu={<button>Option</button>} disabled>
        Run
      </SplitButton>,
    );
    expect(screen.queryByRole('group', { name: 'Options' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Options' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <SplitButton menuLabel="Options" menu={<button>Option</button>} loading>
        Run
      </SplitButton>,
    );
    expect((screen.getByRole('button', { name: 'Options' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
