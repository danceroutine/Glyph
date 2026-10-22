import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

export interface GlyphModelPickerStateOptions {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

export type GlyphModelPickerState = ReturnType<typeof useGlyphModelPickerState>;

export function useGlyphModelPickerState({ state, actions }: GlyphModelPickerStateOptions) {
  const chat = state.chats.find(value => value.id === state.selectedChatId);
  const model = chat?.modelSlug ?? state.selectedModel ?? '';
  return {
    model,
    label:
      state.models.find(value => value.slug === model)?.name ??
      (model || (state.catalogPending === true ? 'Loading models…' : 'No model available')),
    disabled:
      !!chat ||
      state.catalogPending === true ||
      state.navigationPending === true ||
      state.models.length === 0 ||
      state.readOnly,
    models: chat
      ? [{ value: model, label: state.models.find(value => value.slug === model)?.name ?? model }]
      : [
          ...(!model
            ? [{ value: '', label: state.catalogPending === true ? 'Loading models…' : 'No model available' }]
            : []),
          ...state.models.map(value => ({ value: value.slug, label: value.name })),
        ],
    selectModel: (value: string) => {
      void actions.selectModel(value).catch(() => {});
    },
  };
}
