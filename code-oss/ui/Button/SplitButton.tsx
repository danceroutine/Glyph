import { AgentModeID } from '#src/chat/AgentMode.js';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ChevronDown } from 'lucide-preact';
import { Button, IconButton, ButtonAppearance, ButtonVariant, ButtonSize, type ButtonProps } from './Button.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  group: css({
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
    '& > button:first-child': { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
    '& > button:nth-child(2)': {
      // Stretch with the label when inherited text sizing exceeds the icon button's nominal height.
      height: 'auto',
      alignSelf: 'stretch',
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
      borderLeftColor: 'currentColor',
    },
  }),
  menu: css({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 5,
    padding: 4,
    border: tokens.dropdown.border,
    borderRadius: tokens.dropdown.radius,
    background: tokens.dropdown.background,
  }),
};
export interface SplitButtonProps extends ButtonProps {
  readonly menuLabel: string;
  readonly menu: ComponentChildren;
}
/** A primary action plus a separate, keyboard-accessible options popover. */
export function SplitButton({ menuLabel, menu, ...props }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (props.disabled || props.loading) setOpen(false);
  }, [props.disabled, props.loading]);
  return (
    <div
      class={styles.group}
      ref={root}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <Button {...props} />
      <IconButton
        buttonRef={toggle}
        aria-label={menuLabel}
        aria-expanded={open}
        aria-controls={id}
        variant={props.variant ?? ButtonVariant.SECONDARY}
        mode={props.mode ?? AgentModeID.AGENT}
        size={props.size ?? ButtonSize.MEDIUM}
        appearance={props.appearance ?? ButtonAppearance.FILLED}
        disabled={!!props.disabled || !!props.loading}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={14} />
      </IconButton>
      {open && (
        <div
          ref={panel}
          id={id}
          class={styles.menu}
          role="group"
          aria-label={menuLabel}
          onClick={event => {
            if ((event.target as Element).closest('button:not(:disabled)')) {
              setOpen(false);
              toggle.current?.focus();
            }
          }}
        >
          {menu}
        </div>
      )}
    </div>
  );
}
