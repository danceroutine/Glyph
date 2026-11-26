import { GlyphSkillFileComparison } from './GlyphSkillFileComparison.tsx';
import { useState } from 'preact/hooks';
import type { GlyphSkillsManagement } from '#src/desktop/workbench/GlyphSkillsManagement.js';
import { Pencil, Sparkles, TriangleAlert } from 'lucide-preact';
import type { GlyphSkill } from '#src/desktop/protocol/events/GlyphSkill.js';
import { Button, ButtonAppearance, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  toolbar: css({ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, margin: '16px 0' }),
  scope: css({ display: 'inline-flex', alignItems: 'center', gap: 8 }),
  select: css({
    maxWidth: '100%',
    minHeight: 28,
    padding: '4px 8px',
    font: 'inherit',
    color: tokens.dropdown.foreground,
    background: tokens.dropdown.background,
    border: tokens.dropdown.border,
    borderRadius: tokens.dropdown.radius,
    cursor: 'pointer',
    '&:focus-visible': { outline: tokens.focus.ring, outlineOffset: 2 },
  }),
  form: css({
    display: 'grid',
    gap: 16,
    margin: '20px 0',
    '& label': { display: 'grid', gap: 6 },
    '& input, & textarea': {
      background: 'var(--vscode-input-background)',
      color: 'var(--vscode-input-foreground)',
      border: '1px solid var(--vscode-input-border, transparent)',
      borderRadius: 4,
      padding: 8,
      font: 'inherit',
    },
  }),
  preview: css({
    padding: 20,
    border: tokens.border.default,
    borderRadius: 6,
    margin: '24px 0',
    '& summary': { padding: '10px 0' },
    '& pre': { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, maxHeight: 400, overflow: 'auto' },
  }),
  root: css({ height: '100%', overflow: 'auto', color: tokens.text.primary }),
  content: css({ maxWidth: 820, margin: '0 auto', padding: '28px 32px 48px', boxSizing: 'border-box' }),
  heading: css({ margin: '0 0 8px', fontSize: 22, fontWeight: tokens.font.weight.semibold }),
  intro: css({ margin: '0 0 24px', lineHeight: 1.5, color: tokens.text.muted }),
  list: css({ padding: 0, margin: 0, listStyle: 'none' }),
  row: css({ padding: '16px 0', borderTop: tokens.border.default }),
  header: css({ flexWrap: 'wrap', display: 'flex', alignItems: 'center', gap: 10 }),
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
  readonly management?: GlyphSkillsManagement;
  readonly edit: (skill: GlyphSkill) => void;
}

/** Renderer-only Skills settings, driven by the authoritative host catalog. */
export function GlyphSkills({ skills, query = '', edit, management }: GlyphSkillsProps) {
  const [form, setForm] = useState<'create' | 'repository' | undefined>();
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [revision, setRevision] = useState('');
  const [directory, setDirectory] = useState('');
  const [replaceId, setReplaceId] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedTarget = target || management?.targets[0]?.id || '';
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
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
        {management && (
          <div class={styles.toolbar}>
            <label class={styles.scope}>
              Install in{' '}
              <select
                class={styles.select}
                aria-label="Skill installation scope"
                value={selectedTarget}
                disabled={busy}
                onChange={event => {
                  setTarget(event.currentTarget.value);
                }}
              >
                {management.targets.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={busy || !selectedTarget}
              onClick={() => {
                setForm('create');
              }}
            >
              Create skill
            </Button>
            <Button
              disabled={busy || !selectedTarget}
              onClick={() => {
                void perform(() => management.installLocal(selectedTarget));
              }}
            >
              Install local package
            </Button>
            <Button
              disabled={busy || !selectedTarget}
              onClick={() => {
                setReplaceId(undefined);
                setForm('repository');
              }}
            >
              Install from repository
            </Button>
          </div>
        )}
        {management?.message && <p role="status">{management.message}</p>}
        {error && (
          <p role="alert" class={styles.error}>
            {error}
          </p>
        )}
        {management && form && (
          <form
            class={styles.form}
            onSubmit={event => {
              event.preventDefault();
              void perform(async () => {
                if (form === 'create')
                  await management.previewDraft(selectedTarget, {
                    name,
                    source: 'Created in Settings',
                    files: [
                      {
                        path: 'SKILL.md',
                        encoding: 'utf8',
                        content: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`,
                      },
                    ],
                  });
                else
                  await management.previewRepository(
                    selectedTarget,
                    { kind: 'repository', url, revision, directory },
                    replaceId,
                  );
                setForm(undefined);
              });
            }}
          >
            {form === 'create' ? (
              <>
                <label>
                  Name
                  <input
                    required
                    value={name}
                    onInput={event => {
                      setName(event.currentTarget.value);
                    }}
                  />
                </label>
                <label>
                  Description
                  <input
                    required
                    value={description}
                    onInput={event => {
                      setDescription(event.currentTarget.value);
                    }}
                  />
                </label>
                <label>
                  Instructions
                  <textarea
                    required
                    rows={8}
                    value={body}
                    onInput={event => {
                      setBody(event.currentTarget.value);
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Repository URL
                  <input
                    required
                    type="url"
                    value={url}
                    onInput={event => {
                      setUrl(event.currentTarget.value);
                    }}
                  />
                </label>
                <label>
                  Revision
                  <input
                    required
                    placeholder="Commit or tag"
                    value={revision}
                    onInput={event => {
                      setRevision(event.currentTarget.value);
                    }}
                  />
                </label>
                <label>
                  Package directory
                  <input
                    value={directory}
                    onInput={event => {
                      setDirectory(event.currentTarget.value);
                    }}
                  />
                </label>
              </>
            )}
            <div class={styles.toolbar}>
              <Button type="submit" disabled={busy}>
                Preview package
              </Button>
              <Button
                onClick={() => {
                  setForm(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {management?.preview && (
          <section aria-label="Skill change preview" class={styles.preview}>
            <h3>
              {management.preview.action} {management.preview.name}
            </h3>
            <p class={styles.metadata}>
              {management.preview.source} · {management.preview.revision.slice(0, 12)}
            </p>
            {management.preview.destination && (
              <p>
                Destination ({management.preview.destination.scope}) · {management.preview.destination.label}
                <br />
                <code>{management.preview.destination.path}</code>
              </p>
            )}
            <GlyphSkillFileComparison files={management.preview.files} />
            <div class={styles.toolbar}>
              <Button
                disabled={busy}
                onClick={() => {
                  void perform(() => management.apply(management.preview!.id));
                }}
              >
                Apply {management.preview.action}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  void perform(() => management.discard(management.preview!.id));
                }}
              >
                Discard preview
              </Button>
            </div>
          </section>
        )}
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
                  {skill.status !== 'active' ? (
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
                  {skill.status !== 'active' ? 'Unavailable' : skill.enabled ? 'Enabled' : 'Disabled'} ·{' '}
                  {skill.scope === '.' ? 'Workspace-wide' : `${skill.scope}/**`}
                </p>
                <p class={styles.metadata}>
                  {skill.path}
                  {skill.revision ? ` · ${skill.revision.slice(0, 8)}` : ''}
                </p>
                {management && skill.directory && skill.path && (
                  <div class={styles.toolbar}>
                    <Button
                      disabled={busy || skill.status === 'error'}
                      appearance={ButtonAppearance.BORDERLESS_GHOST}
                      onClick={() => {
                        void perform(() => management.setEnabled(skill.id, !skill.enabled));
                      }}
                    >
                      {skill.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    {management.targets.some(location => location.id === skill.origin.id) && (
                      <>
                        <Button
                          disabled={busy}
                          appearance={ButtonAppearance.BORDERLESS_GHOST}
                          onClick={() => {
                            void perform(() => management.installLocal(skill.origin.id, skill.id));
                          }}
                        >
                          Update
                        </Button>
                        <Button
                          disabled={busy}
                          appearance={ButtonAppearance.BORDERLESS_GHOST}
                          onClick={() => {
                            setTarget(skill.origin.id);
                            setReplaceId(skill.id);
                            setForm('repository');
                          }}
                        >
                          Update from repository
                        </Button>
                        <Button
                          disabled={busy}
                          appearance={ButtonAppearance.BORDERLESS_GHOST}
                          onClick={() => {
                            void perform(() => management.remove(skill.id));
                          }}
                        >
                          Uninstall
                        </Button>
                      </>
                    )}
                  </div>
                )}
                {skill.installedFrom && (
                  <p class={styles.metadata}>
                    Installed from {skill.installedFrom} · {skill.packageRevision?.slice(0, 12)}
                  </p>
                )}
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
