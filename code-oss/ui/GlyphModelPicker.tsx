import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { css } from './emotion.ts';

const style = css({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 8,
  color: 'var(--vscode-descriptionForeground)',
  fontSize: 12,
  '& select': {
    minWidth: 0,
    maxWidth: '100%',
    border: '1px solid var(--vscode-dropdown-border, transparent)',
    borderRadius: 4,
    padding: '4px 6px',
    font: 'inherit',
    color: 'var(--vscode-foreground)',
    background: 'var(--vscode-dropdown-background)',
  },
  '& select:focus-visible': { outline: '1px solid var(--vscode-focusBorder)' },
});

export function GlyphModelPicker({
  state,
  actions,
}: {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}) {
  const chat = state.chats.find(value => value.id === state.selectedChatId);
  const model = chat?.modelSlug ?? state.selectedModel ?? '';
  return (
    <label class={`glyph-model-picker ${style}`}>
      Model
      <select
        aria-label="Model"
        value={model}
        disabled={
          !!chat || state.catalogPending || state.navigationPending || state.models.length === 0 || state.readOnly
        }
        onChange={event => {
          void actions.selectModel(event.currentTarget.value).catch(() => {});
        }}
      >
        {chat ? (
          <option value={model}>{state.models.find(value => value.slug === model)?.name ?? model}</option>
        ) : (
          <>
            {!model && <option value="">{state.catalogPending ? 'Loading models…' : 'No model available'}</option>}
            {state.models.map(value => (
              <option key={value.slug} value={value.slug}>
                {value.name}
              </option>
            ))}
          </>
        )}
      </select>
    </label>
  );
}
