import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import type { GlyphContextCandidate } from '#src/desktop/workbench/GlyphContextActions.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { GlyphPromptEditor, type GlyphPromptQuery } from '#code-oss/ui/GlyphPromptEditor/GlyphPromptEditor.ts';
import { GlyphComposerError } from './GlyphComposerError.ts';

export interface GlyphComposerStateOptions {
  readonly disabled?: boolean;
  readonly status: GlyphWorkbenchStatus;
  readonly actions: GlyphWorkbenchViewActions;
}
export type GlyphComposerState = ReturnType<typeof useGlyphComposerState>;

export function useGlyphComposerState({ status, actions, disabled }: GlyphComposerStateOptions) {
  const model = actions.composer;
  const pickerId = useId();
  const [state, setState] = useState(model.snapshot);
  const [query, setQuery] = useState<GlyphPromptQuery>();
  const [candidates, setCandidates] = useState<readonly GlyphContextCandidate[]>([]);
  const [selected, setSelected] = useState(0);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [preview, setPreview] = useState<GlyphContextAttachment>();
  const [sourceStatus, setSourceStatus] = useState<string>();
  const composer = useRef<HTMLDivElement>(null);
  const editor = useRef<GlyphPromptEditor | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);
  const owner = useRef(model);
  owner.current = model;
  const isMounted = () => mounted.current && owner.current === model;
  const active = [
    GlyphWorkbenchStatus.STREAMING,
    GlyphWorkbenchStatus.WAITING_FOR_QUESTION,
    GlyphWorkbenchStatus.WAITING_FOR_APPROVAL,
  ].includes(status);
  const submit = async () => {
    if (!active && !disabled && !busy.current)
      await model.submit((text, attachments, options) => actions.send(text, attachments, options));
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailure(undefined);
    editor.current?.setEditable(false);
    try {
      await operation();
    } catch (error) {
      if (isMounted()) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
      if (isMounted()) {
        setPending(false);
        editor.current?.setEditable(true);
      }
    }
  };
  const choose = (candidate: GlyphContextCandidate) =>
    perform(async () => {
      const position = query;
      const document = model.snapshot.document;
      const attachment = await actions.context.captureFile(candidate.uri);
      if (!isMounted()) return;
      if (document !== model.snapshot.document)
        throw new GlyphComposerError('The prompt changed during capture. Choose the file again.');
      if (!position) throw new GlyphComposerError('Type @ to choose where to insert a file.');
      editor.current?.insert(attachment, position);
      setQuery(undefined);
    });
  const latest = useRef({ submit, choose, candidates, selected, query });
  latest.current = { submit, choose, candidates, selected, query };
  useLayoutEffect(() => {
    mounted.current = true;
    const view = new GlyphPromptEditor(composer.current!, model.snapshot.document, {
      change: document => model.setDocument(document),
      preview: attachment => {
        setPreview(attachment);
        setSourceStatus(undefined);
        void perform(() => actions.context.openAttachment(attachment));
      },
      query: setQuery,
      submit: () => void latest.current.submit(),
      keydown: event => {
        const current = latest.current;
        if (!current.query) return false;
        switch (event.key) {
          case 'Escape':
            setQuery(undefined);
            return true;
          case 'ArrowDown':
            setSelected(value => Math.min(value + 1, Math.max(0, current.candidates.length - 1)));
            return true;
          case 'ArrowUp':
            setSelected(value => Math.max(0, value - 1));
            return true;
          case 'Enter': {
            if (event.metaKey || event.ctrlKey) return false;
            const candidate = current.candidates[current.selected];
            if (candidate) void current.choose(candidate);
            return true;
          }
          default:
            return false;
        }
      },
    });
    editor.current = view;
    let focus = model.snapshot.focus;
    const refresh = () => {
      setState(model.snapshot);
      view.update(model.snapshot.document);
      if (focus !== model.snapshot.focus) {
        focus = model.snapshot.focus;
        view.focus();
      }
    };
    const stop = model.subscribe(refresh);
    refresh();
    if (focus) view.focus();
    return () => {
      mounted.current = false;
      stop();
      view.destroy();
      editor.current = undefined;
    };
  }, [model]);
  useEffect(() => {
    let cancelled = false;
    setCandidates([]);
    setSelected(0);
    if (!query) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void actions.context
        .searchFiles(query.text)
        .then(
          files => {
            if (!cancelled) setCandidates(files);
          },
          error => {
            if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
          },
        )
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query?.text, !!query, actions.context]);
  useEffect(() => {
    let cancelled = false;
    if (preview)
      void actions.context.checkAttachment(preview).then(
        message => {
          if (!cancelled) setSourceStatus(message);
        },
        error => {
          if (!cancelled) setSourceStatus(String(error));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [preview, actions.context]);
  useEffect(() => {
    const input = editor.current?.view.dom;
    if (!input) return;
    input.setAttribute('aria-expanded', String(!!query));
    if (query) input.setAttribute('aria-controls', pickerId);
    else input.removeAttribute('aria-controls');
    if (query && candidates[selected]) input.setAttribute('aria-activedescendant', `${pickerId}-${selected}`);
    else input.removeAttribute('aria-activedescendant');
  }, [pickerId, query, candidates, selected]);
  return {
    mode: state.document.options?.mode ?? 'agent',
    setMode: (mode: 'agent' | 'plan') =>
      perform(async () => {
        if (actions.selectMode) await actions.selectMode(mode);
        else model.setMode(mode);
      }),
    annotations: state.document.options?.annotations ?? [],
    editAnnotation: (id: string) => model.editAnnotation(id),
    removeAnnotation: (id: string) => model.removeAnnotation(id),
    pickerId,
    ...state,
    error: failure ?? state.error,
    composer,
    active,
    disabled: disabled || pending,
    query,
    candidates,
    selected,
    searching,
    pending,
    preview,
    sourceStatus,
    choose,
    attachFile: () =>
      perform(async () => {
        const document = model.snapshot.document;
        const attachments = await actions.context.selectFiles();
        if (!isMounted()) return;
        if (attachments.length) {
          if (document !== model.snapshot.document)
            throw new GlyphComposerError('The prompt changed during capture. Choose the files again.');
          model.insertAttachments(attachments);
          setQuery(undefined);
        }
        editor.current?.focus();
      }),
    submit,
    updateDraft: (text: string) => model.setDraft(text),
    editUnsent: (index: number) => {
      model.editUnsent(index);
      editor.current?.focus();
    },
    closePreview: () => {
      setPreview(undefined);
      editor.current?.focus();
    },
    removePreview: () => {
      if (preview?.id) model.replaceAttachment(preview.id);
      setPreview(undefined);
      editor.current?.focus();
    },
    refreshPreview: () =>
      perform(async () => {
        if (!preview?.id) return;
        const next = await actions.context.refreshAttachment(preview);
        model.replaceAttachment(preview.id, next);
        if (isMounted()) {
          setPreview(next);
          setSourceStatus(undefined);
        }
      }),
    openPreview: () =>
      perform(async () => {
        if (preview) await actions.context.openAttachment(preview);
      }),
    activate: () => {
      if (active) actions.cancel();
      else void submit();
    },
  };
}
