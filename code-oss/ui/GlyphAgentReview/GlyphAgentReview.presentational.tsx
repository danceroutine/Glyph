import { GlyphFileIcon, GlyphFileIcons } from '#code-oss/ui/GlyphFileIcon/GlyphFileIcon.tsx';
import { SplitButtonGroup } from '#code-oss/ui/Button/SplitButton.tsx';
import { useEffect, useState } from 'preact/hooks';
import { ChevronDown, ScanSearch, LoaderCircle, CircleStop, X } from 'lucide-preact';
import { Button, IconButton, ButtonVariant, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { Dropdown } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import {
  GlyphAgentReviewScope,
  glyphAgentReviewLabels,
  type GlyphAgentReviewControls,
} from '#src/desktop/workbench/GlyphAgentReview.js';
const scopes = Object.values(GlyphAgentReviewScope);
const styles = {
  root: css({
    height: '100%',
    boxSizing: 'border-box',
    padding: tokens.space.md,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.space.sm,
  }),
  findings: css({ minHeight: 0, overflowY: 'auto' }),
  spinner: css({
    animation: 'glyph-review-spin 1s linear infinite',
    '@keyframes glyph-review-spin': { to: { transform: 'rotate(360deg)' } },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
  }),
  running: css({
    '& .glyph-review-stop': { display: 'none' },
    ':hover, :focus-visible': {
      '& .glyph-review-spin': { display: 'none' },
      '& .glyph-review-stop': { display: 'block' },
    },
  }),
  issue: css({ display: 'flex', alignItems: 'flex-start', gap: 4 }),
  issueLabel: css({
    '&&': { flex: 1, minWidth: 0, whiteSpace: 'normal', textAlign: 'left', justifyContent: 'flex-start' },
  }),
  file: css({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden',
    '& span:last-child': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }),
  description: css({ color: tokens.text.muted, margin: 0, fontSize: tokens.font.size.body, flexShrink: 0 }),
};
export function GlyphAgentReview(controls: GlyphAgentReviewControls) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const disabled = controls.busy || !!controls.unavailableReason || !!controls.reviewing;
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
          class={controls.reviewing ? styles.running : undefined}
          loading={controls.busy && !controls.reviewing}
          disabled={!controls.reviewing && disabled}
          title={controls.reviewing ? 'Stop Review' : controls.unavailableReason}
          onClick={controls.reviewing ? controls.stop : controls.review}
          leadingIcon={
            controls.reviewing ? (
              <>
                <LoaderCircle class={`glyph-review-spin ${styles.spinner}`} size={16} />
                <CircleStop class="glyph-review-stop" size={16} />
              </>
            ) : (
              <ScanSearch size={16} />
            )
          }
        >
          {controls.reviewing ? 'Reviewing' : 'Find Issues'}
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
        {controls.reviewing
          ? 'Reviewing your changes…'
          : controls.scope === GlyphAgentReviewScope.BRANCH
            ? `Review committed changes since the common ancestor with ${controls.branch.replace(/^refs\/(heads|remotes)\//, '') || 'the selected branch'}.`
            : `Review ${glyphAgentReviewLabels[controls.scope].toLowerCase()} for issues.`}
      </p>
      {controls.findings?.length || controls.completed ? (
        <div class={styles.findings} aria-label="Review findings">
          <p>
            {controls.findings?.length ? `Found ${controls.findings.length} Potential Issues` : 'No issues found'}
            {controls.resultScope ? ` (${controls.resultScope})` : ''}
          </p>
          <GlyphFileIcons.Provider value={controls.fileIconClasses}>
            {[...new Set(controls.findings?.map(finding => finding.path))].map(path => (
              <section key={path}>
                <div class={styles.file} title={path}>
                  <GlyphFileIcon path={path} />
                  <span>{path}</span>
                </div>
                {controls.findings
                  ?.filter(finding => finding.path === path)
                  .map(finding => (
                    <div class={styles.issue} key={finding.id}>
                      <Button
                        class={styles.issueLabel}
                        appearance={ButtonAppearance.GHOST}
                        onClick={() => controls.openFinding?.(finding.id)}
                      >
                        {finding.title}
                      </Button>
                      <Button
                        appearance={ButtonAppearance.GHOST}
                        title="Fix with Agent"
                        onClick={() => controls.fixFinding?.(finding.id)}
                      >
                        Fix
                      </Button>
                      <IconButton
                        title="Dismiss issue"
                        aria-label={`Dismiss ${finding.title}`}
                        onClick={() => controls.dismissFinding?.(finding.id)}
                      >
                        <X size={14} />
                      </IconButton>
                    </div>
                  ))}
              </section>
            ))}
          </GlyphFileIcons.Provider>
        </div>
      ) : null}
      {!controls.reviewing && controls.unavailableReason ? (
        <p role="status">{controls.unavailableReason}</p>
      ) : controls.error ? (
        <p role="alert">{controls.error}</p>
      ) : null}
    </div>
  );
}
