import { fn } from 'storybook/test';
import { Button, ButtonVariant } from '#code-oss/ui/Button/Button.tsx';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { atoms, css, tokens } from './index.ts';

const styles = {
  root: css({ height: '100%', boxSizing: 'border-box', overflowY: 'auto', padding: tokens.space.xl }),
  heading: css({ fontSize: tokens.font.size.heading, fontWeight: tokens.font.weight.semibold }),
  row: css({ display: 'flex', alignItems: 'center', gap: tokens.space.md, marginBottom: tokens.space.md }),
  swatch: css({
    width: 24,
    height: 24,
    flexShrink: 0,
    borderRadius: tokens.button.radius,
    border: tokens.border.default,
  }),
  label: css({ fontFamily: tokens.font.family.code, fontSize: tokens.font.size.caption, overflowWrap: 'anywhere' }),
  bar: css({ height: 8, background: tokens.progress.foreground }),
  card: css({ padding: tokens.space.lg, border: tokens.border.default, borderRadius: tokens.card.radius }),
  muted: css({ color: tokens.text.muted, fontSize: tokens.font.size.detail }),
};

interface ColorTree {
  readonly [name: string]: string | ColorTree;
}

function colorEntries(tree: ColorTree, prefix: string): { name: string; value: string }[] {
  return Object.entries(tree).flatMap(([name, value]) =>
    typeof value === 'string' ? [{ name: `${prefix}.${name}`, value }] : colorEntries(value, `${prefix}.${name}`),
  );
}

const semanticColors = {
  text: tokens.text,
  surface: tokens.surface,
  border: tokens.border.color,
  focus: tokens.focus.color,
  input: { background: tokens.input.background, foreground: tokens.input.foreground },
  dropdown: { background: tokens.dropdown.background, foreground: tokens.dropdown.foreground },
  button: {
    background: tokens.button.background,
    foreground: tokens.button.foreground,
    hoverBackground: tokens.button.hoverBackground,
    secondary: tokens.button.secondary,
    quiet: tokens.button.quiet,
  },
  list: { hoverBackground: tokens.list.hoverBackground, selected: tokens.list.selected },
  progress: tokens.progress,
};

function TokenGallery() {
  return (
    <div class={styles.root}>
      <h2 class={styles.heading}>Semantic colors</h2>
      <p class={styles.muted}>Switch the toolbar theme to inspect each role.</p>
      {colorEntries(semanticColors, 'tokens').map(({ name, value }) => (
        <div class={styles.row} key={name}>
          <span class={styles.swatch} style={{ background: value }} aria-hidden="true" />
          <code class={styles.label}>{name}</code>
        </div>
      ))}
      <h2 class={styles.heading}>Atomic palette</h2>
      {colorEntries(atoms.color, 'atoms.color').map(({ name, value }) => (
        <div class={styles.row} key={name}>
          <span class={styles.swatch} style={{ background: value }} aria-hidden="true" />
          <code class={styles.label}>{name}</code>
        </div>
      ))}
      <h2 class={styles.heading}>Atomic spacing</h2>
      {Object.entries(atoms.space).map(([name, value]) => (
        <div class={styles.row} key={name}>
          <code class={styles.label}>space.{name}</code>
          <span class={styles.bar} style={{ width: value }} aria-hidden="true" />
        </div>
      ))}
      <h2 class={styles.heading}>Atomic radii</h2>
      {Object.entries(atoms.radius).map(([name, value]) => (
        <div class={styles.row} key={name}>
          <span
            class={styles.swatch}
            style={{ borderRadius: value, background: tokens.text.muted }}
            aria-hidden="true"
          />
          <code class={styles.label}>radius.{name}</code>
        </div>
      ))}
      <h2 class={styles.heading}>Atomic font sizes</h2>
      {Object.entries(atoms.fontSize).map(([name, value]) => (
        <div class={styles.row} key={name}>
          <span style={{ fontSize: value }}>fontSize.{name}</span>
        </div>
      ))}
      <h2 class={styles.heading}>Surface and action</h2>
      <div class={styles.card}>
        <p>Body text</p>
        <p class={styles.muted}>Supporting text uses the muted semantic role.</p>
        <Button variant={ButtonVariant.PRIMARY} onClick={fn().mockName('Tokens.primaryAction')}>
          Primary action
        </Button>
      </div>
    </div>
  );
}

const meta = { title: 'Glyph/Shared/Design system', component: TokenGallery } satisfies Meta<typeof TokenGallery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Tokens: Story = {};
