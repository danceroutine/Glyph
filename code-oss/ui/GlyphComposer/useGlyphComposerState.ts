import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchSelection } from '#src/desktop/workbench/GlyphWorkbenchSelection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

export interface GlyphComposerStateOptions {
  readonly disabled?: boolean;
  readonly status: GlyphWorkbenchStatus;
  readonly selection: GlyphWorkbenchSelection | undefined;
  readonly actions: GlyphWorkbenchViewActions;
}

export type GlyphComposerState = ReturnType<typeof useGlyphComposerState>;

/** Subscribes to the window-owned draft for the lifetime of the mounted composer. */
export function useGlyphComposerState({ status, selection, actions, disabled }: GlyphComposerStateOptions) {
  const model = actions.composer;
  const [state, setState] = useState(model.snapshot);
  useLayoutEffect(() => {
    const refresh = () => setState(model.snapshot);
    const stop = model.subscribe(refresh);
    refresh();
    return stop;
  }, [model]);
  const { draft, unsent, error } = state;
  const composer = useRef<HTMLTextAreaElement>(null);
  const active =
    status === GlyphWorkbenchStatus.STREAMING ||
    status === GlyphWorkbenchStatus.WAITING_FOR_QUESTION ||
    status === GlyphWorkbenchStatus.WAITING_FOR_APPROVAL;
  const updateDraft = (text: string) => {
    model.setDraft(text);
  };
  const editUnsent = (index: number) => {
    model.editUnsent(index);
    composer.current?.focus();
  };
  const submit = async () => {
    if (!active && !disabled) await model.submit(text => actions.send(text));
  };
  return {
    draft,
    unsent,
    error,
    composer,
    active,
    disabled,
    updateDraft,
    editUnsent,
    submit,
    context: selection
      ? `Context: ${selection.path} (${selection.text.length} chars, v${selection.version})`
      : 'No editor selection attached',
    activate: () => {
      if (active) actions.cancel();
      else void submit();
    },
  };
}
