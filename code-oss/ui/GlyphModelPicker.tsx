import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { css, tokens, space } from './design-system/index.ts';

const style = css({
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space.md,
  marginTop: tokens.space.md,
  color: tokens.text.muted,
  fontSize: tokens.font.size.detail,
  '& select': {
    minWidth: 0,
    maxWidth: '100%',
    border: tokens.dropdown.border,
    borderRadius: tokens.dropdown.radius,
    padding: space('xs', 'sm'),
    font: 'inherit',
    color: tokens.dropdown.foreground,
    background: tokens.dropdown.background,
  },
  '& select:focus-visible': { outline: tokens.focus.ring },
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
