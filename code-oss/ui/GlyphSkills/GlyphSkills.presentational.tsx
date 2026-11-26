import { Pencil, Sparkles, TriangleAlert } from 'lucide-preact';
import type { GlyphSkill } from '#src/desktop/protocol/events/GlyphSkill.js';
import { Button, ButtonAppearance, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({ height: '100%', overflow: 'auto', color: tokens.text.primary }),
  content: css({ maxWidth: 820, margin: '0 auto', padding: '28px 32px 48px', boxSizing: 'border-box' }),
  heading: css({ margin: '0 0 8px', fontSize: 22, fontWeight: tokens.font.weight.semibold }),
  intro: css({ margin: '0 0 24px', lineHeight: 1.5, color: tokens.text.muted }),
  list: css({ padding: 0, margin: 0, listStyle: 'none' }),
  row: css({ padding: '16px 0', borderTop: tokens.border.default }),
  header: css({ display: 'flex', alignItems: 'center', gap: 10 }),
  name: css({
    margin: 0,
    fontSize: 14,
    fontWeight: tokens.font.weight.semibold,
    flex: 1,
    minWidth: 0,
    overflowWrap: 'anywhere',
  }),
  description: css({ margin: '8px 0 8px 26px', lineHeight: 1.5 }),
  metadata: css({
    margin: '4px 0 0 26px',
    color: tokens.text.muted,
    fontSize: tokens.font.size.detail,
    overflowWrap: 'anywhere',
  }),
  error: css({ color: 'var(--vscode-errorForeground)', margin: '8px 0 0 26px' }),
  empty: css({ padding: '24px 0', color: tokens.text.muted }),
};

export interface GlyphSkillsProps {
  readonly skills: readonly GlyphSkill[];
  readonly query?: string;
  readonly edit: (skill: GlyphSkill) => void;
}

/** Renderer-only Skills settings, driven by the authoritative host catalog. */
export function GlyphSkills({ skills, query = '', edit }: GlyphSkillsProps) {
  const search = query.trim().toLocaleLowerCase();
  const visible = skills.filter(skill =>
    [skill.name, skill.description, skill.path, skill.origin.label, skill.message ?? ''].some(value =>
      value.toLocaleLowerCase().includes(search),
    ),
  );
  return (
    <section class={styles.root} aria-label="Skills">
      <div class={styles.content}>
        <h2 class={styles.heading}>Skills</h2>
        <p class={styles.intro}>
          Reusable workflows for your agent. Select a skill with / in chat, or let the agent choose one from its
          description. Instructions load when activated; resources enter context only when requested.
        </p>
        {visible.length === 0 ? (
          <p class={styles.empty}>
            {search
              ? 'No skills match your search.'
              : 'No skills found. Add a SKILL.md package under .glyph/skills or ~/.glyph/skills.'}
          </p>
        ) : (
          <ul class={styles.list}>
            {visible.map(skill => (
              <li class={styles.row} key={skill.id} aria-label={`${skill.name} · ${skill.origin.label}`}>
                <div class={styles.header}>
                  {skill.status === 'error' ? (
                    <TriangleAlert size={16} aria-hidden="true" />
                  ) : (
                    <Sparkles size={16} aria-hidden="true" />
                  )}
                  <h3 class={styles.name}>{skill.name}</h3>
                  <Button
                    type="button"
                    size={ButtonSize.SMALL}
                    appearance={ButtonAppearance.BORDERLESS_GHOST}
                    disabled={!skill.uri}
                    onClick={() => {
                      edit(skill);
                    }}
                    aria-label={`Edit ${skill.name} · ${skill.origin.label}`}
                  >
                    <Pencil size={14} aria-hidden="true" />
                    Edit
                  </Button>
                </div>
                {skill.description && <p class={styles.description}>{skill.description}</p>}
                <p class={styles.metadata}>
                  {skill.origin.label} ·{' '}
                  {skill.status === 'error' ? 'Unavailable' : skill.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                  {skill.scope === '.' ? 'Workspace-wide' : `${skill.scope}/**`}
                </p>
                <p class={styles.metadata}>
                  {skill.path}
                  {skill.revision ? ` · ${skill.revision.slice(0, 8)}` : ''}
                </p>
                {skill.compatibility && <p class={styles.metadata}>Compatibility: {skill.compatibility}</p>}
                {skill.message && (
                  <p class={styles.error} role="status">
                    {skill.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
