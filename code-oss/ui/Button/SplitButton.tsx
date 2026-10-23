import { cloneElement, isValidElement, toChildArray } from 'preact';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, HTMLAttributes, Ref, VNode } from 'preact';
import { ChevronDown } from 'lucide-preact';
import { Button, IconButton, ButtonAppearance, ButtonVariant, ButtonSize, isOn, type ButtonProps } from './Button.tsx';
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
  fullWidth: css({ width: '100%', '& > button:first-child': { flex: 1, minWidth: 0 } }),
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
/** Shared joined-button geometry, also usable with the standard Dropdown primitive. */
export function SplitButtonGroup({
  children,
  fullWidth,
  groupRef,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly fullWidth?: boolean; readonly groupRef?: Ref<HTMLDivElement> }) {
  const segments = toChildArray(children);
  const primary = segments[0];
  const trigger = segments[1];
  if (isValidElement(primary) && primary.type === Button && isValidElement(trigger) && trigger.type === IconButton) {
    const palette = (primary as VNode<ButtonProps>).props;
    segments[1] = cloneElement(trigger as VNode<ButtonProps>, {
      variant: palette.variant ?? ButtonVariant.SECONDARY,
      appearance: palette.appearance ?? ButtonAppearance.FILLED,
      mode: palette.mode ?? AgentModeID.AGENT,
      size: palette.size ?? ButtonSize.MEDIUM,
    });
  }
  return (
    <div
      {...props}
      {...(groupRef ? { ref: groupRef } : {})}
      class={`${styles.group} ${fullWidth === true ? styles.fullWidth : ''}`}
    >
      {segments}
    </div>
  );
}
export interface SplitButtonProps extends ButtonProps {
  readonly menuLabel: string;
  readonly menu: ComponentChildren;
  readonly menuDisabled?: boolean;
}
/** A primary action plus a separate, keyboard-accessible options popover. */
export function SplitButton({ menuLabel, menu, menuDisabled, ...props }: SplitButtonProps) {
  const unavailable = menuDisabled ?? (isOn(props.disabled) || props.loading === true);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);
  return (
    <SplitButtonGroup
      groupRef={root}
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
        disabled={unavailable}
        onClick={() => {
          setOpen(value => !value);
        }}
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
            if (event.target instanceof Element && event.target.closest('button:not(:disabled)') !== null) {
              setOpen(false);
              toggle.current?.focus();
            }
          }}
        >
          {menu}
        </div>
      )}
    </SplitButtonGroup>
  );
}
