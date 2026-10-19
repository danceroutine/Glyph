import { SplitButtonGroup } from '#code-oss/ui/Button/SplitButton.tsx';
import { useEffect, useState } from 'preact/hooks';
import { ChevronDown, ScanSearch } from 'lucide-preact';
import { Button, IconButton, ButtonVariant } from '#code-oss/ui/Button/Button.tsx';
import { Dropdown } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import {
  GlyphAgentReviewScope,
  glyphAgentReviewLabels,
  type GlyphAgentReviewControls,
} from '#src/desktop/workbench/GlyphAgentReview.js';
const scopes = Object.values(GlyphAgentReviewScope);
const styles = {
  root: css({ padding: tokens.space.md, display: 'flex', flexDirection: 'column', gap: tokens.space.sm }),
  description: css({ color: tokens.text.muted, margin: 0, fontSize: tokens.font.size.body }),
};
export function GlyphAgentReview(controls: GlyphAgentReviewControls) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const disabled = controls.busy || !!controls.unavailableReason;
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const selected = scopes.indexOf(controls.scope);
  const choose = (scope: GlyphAgentReviewScope) => {
    setOpen(false);
    controls.chooseScope(scope);
  };
  return (
    <div class={styles.root}>
      <SplitButtonGroup
        fullWidth
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
        }}
      >
        <Button
          variant={ButtonVariant.PRIMARY}
          loading={controls.busy}
          disabled={disabled}
          title={controls.unavailableReason}
          onClick={controls.review}
          leadingIcon={<ScanSearch size={16} />}
        >
          Find Issues
        </Button>
        <IconButton
          variant={ButtonVariant.PRIMARY}
          title={`Review scope: ${glyphAgentReviewLabels[controls.scope]}`}
          disabled={disabled}
          role="combobox"
          aria-label="Review scope"
          aria-expanded={open && !disabled}
          aria-controls={open && !disabled ? 'glyph-review-scopes' : undefined}
          aria-haspopup="listbox"
          aria-activedescendant={open && !disabled ? `glyph-review-scopes-${active}` : undefined}
          onClick={() => {
            setActive(selected);
            setOpen(!open);
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              setOpen(false);
              event.preventDefault();
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + scopes.length) % scopes.length);
            }
            if (open && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              choose(scopes[active]!);
            }
          }}
        >
          <ChevronDown size={14} />
        </IconButton>
        {open && !disabled && (
          <Dropdown
            topLayer
            id="glyph-review-scopes"
            label="Review scopes"
            items={scopes}
            itemKey={scope => scope}
            itemLabel={scope => glyphAgentReviewLabels[scope]}
            activeIndex={active}
            selectedIndex={selected}
            highlight={setActive}
            choose={choose}
            showCheck
            width={230}
            renderItem={scope => <span>{glyphAgentReviewLabels[scope]}</span>}
          />
        )}
      </SplitButtonGroup>
      <p class={styles.description}>
        {controls.scope === GlyphAgentReviewScope.BRANCH
          ? `Review committed changes since the common ancestor with ${controls.branch.replace(/^refs\/(heads|remotes)\//, '') || 'the selected branch'}.`
          : `Review ${glyphAgentReviewLabels[controls.scope].toLowerCase()} for issues.`}
      </p>
      {controls.unavailableReason ? (
        <p role="status">{controls.unavailableReason}</p>
      ) : controls.error ? (
        <p role="alert">{controls.error}</p>
      ) : null}
    </div>
  );
}
