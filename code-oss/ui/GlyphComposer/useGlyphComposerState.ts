import { dropdownNavigationIndex } from '#code-oss/ui/Dropdown/useDropdownState.ts';
import { GlyphFollowUpBehavior } from '#src/desktop/workbench/GlyphFollowUpBehavior.js';
import { GlyphComposerCommand } from '#src/desktop/workbench/GlyphComposerCommand.js';
import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphContextCandidateKind, type GlyphContextCandidate } from '#src/desktop/workbench/GlyphContextActions.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
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
    if (disabled === true || busy.current) return;
    if (
      (model.snapshot.editingQueuedMessage !== undefined && model.snapshot.editingQueuedMessage !== '') ||
      (active && actions.followUpBehavior !== GlyphFollowUpBehavior.SEND_IMMEDIATELY)
    ) {
      model.enqueueDraft();
    } else if (active) {
      if (actions.sendImmediately)
        await model.submit((text, attachments, options) => actions.sendImmediately!(text, attachments, options));
    } else await model.submit((text, attachments, options) => actions.send(text, attachments, options));
  };
  const steer = async () => {
    if (active && disabled !== true && !busy.current && actions.steer)
      await model.submit((text, attachments, options) => actions.steer!(text, attachments, options));
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
  const choose = async (candidate: GlyphContextCandidate) => {
    await perform(async () => {
      const position = query;
      const document = model.snapshot.document;
      if (candidate.kind === GlyphContextCandidateKind.RULE) {
        if (!position || !candidate.ruleId) throw new GlyphComposerError('This rule cannot be selected.');
        editor.current?.insert(
          {
            kind: GlyphContextAttachmentKind.RULE,
            uri: candidate.uri,
            path: candidate.name ?? candidate.path,
            text: '',
            contentRevision: candidate.revision ?? candidate.ruleId,
            ruleId: candidate.ruleId,
          },
          position,
        );
        setQuery(undefined);
        return;
      }
      const capture =
        candidate.kind === GlyphContextCandidateKind.FOLDER
          ? actions.context.captureFolder?.bind(actions.context)
          : actions.context.captureFile.bind(actions.context);
      if (!capture) throw new GlyphComposerError('Folder context is unavailable.');
      const attachment = await capture(candidate.uri);
      if (!isMounted()) return;
      if (document !== model.snapshot.document)
        throw new GlyphComposerError('The prompt changed during capture. Choose the file again.');
      if (!position) throw new GlyphComposerError('Type @ to choose where to insert a file.');
      editor.current?.insert(attachment, position);
      setQuery(undefined);
    });
    if (isMounted()) editor.current?.focus();
  };
  const latest = useRef({ submit, steer, choose, candidates, selected, query });
  latest.current = { submit, steer, choose, candidates, selected, query };
  useLayoutEffect(() => {
    mounted.current = true;
    const view = new GlyphPromptEditor(composer.current!, model.snapshot.document, {
      change: document => {
        model.setDocument(document);
      },
      preview: attachment => {
        setPreview(['file', 'selection', 'folder'].includes(attachment.kind) ? attachment : undefined);
        setSourceStatus(undefined);
        void perform(() => actions.context.openAttachment(attachment));
      },
      describe: attachment => actions.context.checkAttachment(attachment),
      query: setQuery,
      submit: () => void latest.current.submit(),
      steer: () => void latest.current.steer(),
      nativeKeybindings: !!actions.composerKeybindings,
      keydown: event => {
        const current = latest.current;
        if (!current.query) return actions.composerKeybindings?.dispatch(event) ?? false;
        switch (event.key) {
          case 'Escape':
            setQuery(undefined);
            return true;
          case 'ArrowDown':
            setSelected(value => dropdownNavigationIndex(event.key, value, current.candidates.length, false) ?? 0);
            return true;
          case 'ArrowUp':
            setSelected(value => dropdownNavigationIndex(event.key, value, current.candidates.length, false) ?? 0);
            return true;
          case 'Enter': {
            if (event.metaKey || event.ctrlKey || event.shiftKey)
              return actions.composerKeybindings?.dispatch(event) ?? false;
            const candidate = current.candidates[current.selected];
            if (candidate) void current.choose(candidate);
            return true;
          }
          default:
            return actions.composerKeybindings?.dispatch(event) ?? false;
        }
      },
    });
    editor.current = view;
    const unbind = actions.composerKeybindings?.mount(view.view.dom);
    const unregister = model.registerCommands(command => {
      if (view.view.composing || busy.current) return;
      switch (command) {
        case GlyphComposerCommand.SEND:
          void latest.current.submit();
          break;
        case GlyphComposerCommand.STEER:
          void latest.current.steer();
          break;
        case GlyphComposerCommand.INSERT_NEWLINE:
          view.insertNewline();
          break;
      }
    });
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
      unregister();
      unbind?.();
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
      return undefined;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      const result =
        query.trigger === '/' ? actions.context.searchRules(query.text) : actions.context.searchFiles(query.text);
      void result
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
    const input = editor.current!.view.dom;
    input.setAttribute('aria-expanded', String(!!query));
    if (query) input.setAttribute('aria-controls', pickerId);
    else input.removeAttribute('aria-controls');
    if (query && candidates[selected]) input.setAttribute('aria-activedescendant', `${pickerId}-${selected}`);
    else input.removeAttribute('aria-activedescendant');
  }, [pickerId, query, candidates, selected]);
  useEffect(() => {
    const first = state.queued[0];
    if (
      actions.managesQueue !== true &&
      !active &&
      disabled !== true &&
      first &&
      !state.queuePaused &&
      state.queueSubmitting === undefined &&
      state.editingQueuedMessage === undefined
    )
      void model.sendQueued(first.id, (text, attachments, options) => actions.send(text, attachments, options));
  }, [active, disabled, state.queued, state.queuePaused, state.queueSubmitting, state.editingQueuedMessage, model]);
  const sendShortcut = actions.composerKeybindings
    ? actions.composerKeybindings.label(GlyphComposerCommand.SEND)
    : 'Enter';
  return {
    saveQueueLabel:
      state.editingQueuedMessage !== undefined && state.editingQueuedMessage !== ''
        ? 'Save queued message'
        : active && state.draft.trim()
          ? actions.followUpBehavior === GlyphFollowUpBehavior.SEND_IMMEDIATELY
            ? 'Send immediately'
            : 'Queue message'
          : undefined,
    moveQueuedToNewChat: (id: string) => {
      if (actions.moveQueuedToNewChat) void perform(() => actions.moveQueuedToNewChat!(id));
    },
    openMessageSettings: () => actions.openMessageSettings?.(),
    sendQueued: (id: string) => {
      if (disabled !== true && actions.sendImmediately)
        void model.sendQueued(id, (text, attachments, options) => actions.sendImmediately!(text, attachments, options));
    },
    steerQueued: (id: string) => {
      if (active && disabled !== true && actions.steer)
        void model.sendQueued(id, (text, attachments, options) => actions.steer!(text, attachments, options));
    },
    cancelQueueEdit: () => {
      model.cancelQueueEdit();
    },
    editQueued: (id: string) => {
      model.editQueued(id);
    },
    removeQueued: (id: string) => {
      model.removeQueued(id);
    },
    moveQueued: (id: string, target: number) => {
      model.moveQueued(id, target);
    },
    resumeQueue: () => {
      model.resumeQueue();
    },
    cancel: () => {
      model.pauseQueue();
      actions.cancel();
    },
    sendLabel: sendShortcut !== undefined && sendShortcut !== '' ? `Send (${sendShortcut})` : 'Send',
    mode: state.document.options?.mode ?? AgentMode.default.id,
    setMode: (mode: AgentModeID) =>
      perform(async () => {
        if (actions.selectMode) await actions.selectMode(mode);
        else model.setMode(mode);
      }),
    annotations: state.document.options?.annotations ?? [],
    editAnnotation: (id: string) => {
      model.editAnnotation(id);
    },
    removeAnnotation: (id: string) => {
      model.removeAnnotation(id);
    },
    pickerId,
    ...state,
    error: failure ?? state.error,
    composer,
    active,
    disabled: disabled === true || pending,
    query,
    candidates,
    highlightCandidate: setSelected,
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
        if (attachments.length > 0) {
          if (document !== model.snapshot.document)
            throw new GlyphComposerError('The prompt changed during capture. Choose the files again.');
          model.insertAttachments(attachments);
          setQuery(undefined);
        }
        editor.current?.focus();
      }),
    submit,
    updateDraft: (text: string) => {
      model.setDraft(text);
    },
    editUnsent: (index: number) => {
      model.editUnsent(index);
      editor.current?.focus();
    },
    closePreview: () => {
      setPreview(undefined);
      editor.current?.focus();
    },
    removePreview: () => {
      if (preview?.id !== undefined && preview?.id !== '') model.replaceAttachment(preview.id);
      setPreview(undefined);
      editor.current?.focus();
    },
    refreshPreview: () =>
      perform(async () => {
        if (preview?.id === undefined || preview?.id === '') return;
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
      if (active && state.editingQueuedMessage === undefined && !state.draft.trim()) {
        model.pauseQueue();
        actions.cancel();
      } else void submit();
    },
  };
}
