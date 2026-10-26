import { FileText, TriangleAlert } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { GlyphInstructionSource } from '#src/desktop/protocol/events/GlyphInstructionSource.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    height: '100%',
    overflow: 'auto',
    color: tokens.text.primary,
  }),
  content: css({
    width: 'min(760px, calc(100% - 48px))',
    margin: '0 auto',
    padding: '28px 24px 48px',
    boxSizing: 'border-box',
  }),
  heading: css({ margin: '0 0 8px', fontSize: 22, fontWeight: tokens.font.weight.semibold }),
  description: css({ margin: '0 0 24px', color: tokens.text.muted, lineHeight: 1.5 }),
  create: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 1fr) 150px auto',
    gap: 8,
    marginBottom: 24,
  }),
  control: css({
    minWidth: 0,
    height: 30,
    boxSizing: 'border-box',
    border: tokens.border.default,
    borderRadius: 3,
    color: tokens.text.primary,
    background: 'var(--vscode-input-background)',
    padding: '0 8px',
    font: 'inherit',
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
  }),
  action: css({
    height: 30,
    border: 0,
    borderRadius: 3,
    padding: '0 10px',
    color: 'var(--vscode-button-foreground)',
    background: 'var(--vscode-button-background)',
    cursor: 'pointer',
    ':hover': { background: 'var(--vscode-button-hoverBackground)' },
    ':disabled': { opacity: 0.5, cursor: 'default' },
  }),
  empty: css({ padding: '24px 0', color: tokens.text.muted }),
  source: css({
    padding: '14px 0',
    borderTop: tokens.border.default,
    ':last-child': { borderBottom: tokens.border.default },
  }),
  name: css({ margin: '0 0 4px 24px', fontWeight: tokens.font.weight.semibold }),
  path: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    maxWidth: '100%',
    padding: '2px 0',
    border: 0,
    color: 'var(--vscode-textLink-foreground)',
    background: 'transparent',
    font: 'inherit',
    fontWeight: tokens.font.weight.semibold,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover span': { textDecoration: 'underline' },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
  }),
  errorPath: css({ color: tokens.text.error }),
  pathText: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  metadata: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 16px',
    margin: '7px 0 0 24px',
    color: tokens.text.muted,
  }),
  kind: css({
    color: 'var(--vscode-badge-foreground)',
    background: 'var(--vscode-badge-background)',
    borderRadius: tokens.badge.radius,
    padding: '1px 6px',
    fontSize: 11,
    lineHeight: '16px',
  }),
  scope: css({ lineHeight: '18px' }),
  message: css({ margin: '8px 0 0 24px', color: tokens.text.error, lineHeight: 1.4 }),
  details: css({ margin: '10px 0 0 24px', color: tokens.text.muted }),
  preview: css({
    whiteSpace: 'pre-wrap',
    color: tokens.text.primary,
    border: tokens.border.default,
    borderRadius: 4,
    padding: 12,
    maxHeight: 240,
    overflow: 'auto',
  }),
  rowActions: css({ display: 'flex', gap: 8, margin: '10px 0 0 24px' }),
  secondary: css({
    border: 0,
    padding: 0,
    color: tokens.text.muted,
    background: 'transparent',
    cursor: 'pointer',
    ':hover': { color: tokens.text.primary },
  }),
};

export interface GlyphAgentInstructionsProps {
  readonly sources: readonly GlyphInstructionSource[];
  readonly query?: string;
  readonly openSource: (source: GlyphInstructionSource) => void;
  readonly createUserRule?: (name: string, activation: NonNullable<GlyphInstructionSource['activation']>) => void;
  readonly setUserRuleEnabled?: (source: GlyphInstructionSource, enabled: boolean) => void;
  readonly deleteUserRule?: (source: GlyphInstructionSource) => void;
}

/** Searchable, provider-neutral presentation of workspace instruction sources. */
export function GlyphAgentInstructions({
  sources,
  query = '',
  openSource,
  createUserRule,
  setUserRuleEnabled,
  deleteUserRule,
}: GlyphAgentInstructionsProps) {
  const [name, setName] = useState('');
  const [activation, setActivation] = useState<NonNullable<GlyphInstructionSource['activation']>>('manual');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = sources.filter(source => matches(source, normalizedQuery));
  return (
    <section class={`glyph-agent-instructions-settings ${styles.root}`} aria-labelledby="glyph-instructions-heading">
      <div class={styles.content}>
        <h2 class={styles.heading} id="glyph-instructions-heading">
          Agent Instructions
        </h2>
        <p class={styles.description}>
          Instructions active for this workspace and account. Scoped files apply to their directory and descendants;
          nearer project rules take precedence.
        </p>
        {createUserRule && (
          <form
            class={styles.create}
            onSubmit={event => {
              event.preventDefault();
              if (!name.trim()) return;
              createUserRule(name, activation);
              setName('');
            }}
          >
            <input
              class={styles.control}
              aria-label="New user rule name"
              placeholder="New user rule"
              value={name}
              onInput={event => {
                setName(event.currentTarget.value);
              }}
            />
            <select
              class={styles.control}
              aria-label="Rule activation"
              value={activation}
              onChange={event => {
                const value = event.currentTarget.value;
                if (isRuleActivation(value)) setActivation(value);
              }}
            >
              <option value="always">Always</option>
              <option value="file_pattern">Matching files</option>
              <option value="model">Model selected</option>
              <option value="manual">Manual</option>
            </select>
            <button class={styles.action} type="submit" disabled={!name.trim()}>
              Create
            </button>
          </form>
        )}
        {visible.length === 0 ? (
          <p class={styles.empty}>
            {normalizedQuery
              ? 'No instruction files match your search.'
              : 'No active instruction files were found in this workspace.'}
          </p>
        ) : (
          visible.map(source => (
            <article class={`instruction-source ${styles.source}`} data-status={source.status} key={source.id}>
              {source.name && <div class={styles.name}>{source.name}</div>}
              <button
                class={`source-path ${styles.path} ${source.status === 'error' ? styles.errorPath : ''}`}
                type="button"
                title={`Open ${source.path}`}
                onClick={() => {
                  openSource(source);
                }}
              >
                {source.status === 'error' ? (
                  <TriangleAlert size={16} aria-hidden="true" />
                ) : (
                  <FileText size={16} aria-hidden="true" />
                )}
                <span class={`path ${styles.pathText}`}>{source.path}</span>
              </button>
              <div class={`source-metadata ${styles.metadata}`}>
                <span class={`kind ${styles.kind}`}>{source.label}</span>
                {source.activation && <span>{activationLabel(source.activation)}</span>}
                {source.enabled === false && <span>Disabled</span>}
                <span class={`scope ${styles.scope}`}>
                  Applies to {source.scope === '.' ? 'the workspace' : `${source.scope}/**`}
                </span>
              </div>
              {source.message && <p class={`source-message ${styles.message}`}>{source.message}</p>}
              {(source.description || source.globs?.length || source.references?.length) && (
                <div class={styles.details}>
                  {source.description && <div>{source.description}</div>}
                  {source.globs?.length ? <div>Matches: {source.globs.join(', ')}</div> : null}
                  {source.references?.length ? <div>References: {source.references.join(', ')}</div> : null}
                </div>
              )}
              {source.content && (
                <details class={styles.details}>
                  <summary>Preview</summary>
                  <pre class={styles.preview}>{source.content}</pre>
                </details>
              )}
              {source.managementPath && source.managementRevision && (
                <div class={styles.rowActions}>
                  <button
                    class={styles.secondary}
                    type="button"
                    onClick={() => {
                      openSource(source);
                    }}
                  >
                    Edit
                  </button>
                  {setUserRuleEnabled && (
                    <button
                      class={styles.secondary}
                      type="button"
                      onClick={() => {
                        setUserRuleEnabled(source, source.enabled === false);
                      }}
                    >
                      {source.enabled === false ? 'Enable' : 'Disable'}
                    </button>
                  )}
                  {deleteUserRule && (
                    <button
                      class={styles.secondary}
                      type="button"
                      onClick={() => {
                        deleteUserRule(source);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function isRuleActivation(value: string): value is NonNullable<GlyphInstructionSource['activation']> {
  return value === 'always' || value === 'file_pattern' || value === 'model' || value === 'manual';
}

function activationLabel(activation: NonNullable<GlyphInstructionSource['activation']>): string {
  return {
    always: 'Always',
    file_pattern: 'Matching files',
    model: 'Model selected',
    manual: 'Manual',
  }[activation];
}

function matches(source: GlyphInstructionSource, query: string): boolean {
  if (!query) return true;
  return [source.path, source.scope, source.label, source.status, source.message, source.name, source.description]
    .filter((value): value is string => value !== undefined)
    .some(value => value.toLocaleLowerCase().includes(query));
}
