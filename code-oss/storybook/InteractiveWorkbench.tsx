import { GlyphFollowUpBehavior } from '#src/desktop/workbench/GlyphFollowUpBehavior.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { chatFixture, workbenchStateFixture } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { composerFixture, previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import {
  userMessageFixture,
  agentMessageFixture,
  conversationFixture,
} from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';

import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { WiredGlyphWorkbench } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.wired.tsx';

/** A local simulation for UI iteration. It never connects to the desktop host. */
export function InteractiveWorkbench() {
  const [composer, setComposer] = useState(() => composerFixture());
  const [state, setState] = useState(() =>
    workbenchStateFixture({ selectedChatId: 'preview', transcript: conversationFixture() }),
  );
  const [pending, setPending] = useState<{ id: string; response: string }>();
  const [followUpBehavior, setFollowUpBehavior] = useState(GlyphFollowUpBehavior.QUEUE);
  const [messageSettings, setMessageSettings] = useState(false);
  const nextTurn = useRef(0);
  const steering = useRef<string[]>([]);

  useEffect(() => {
    if (!pending) return;
    let length = state.transcript.find(entry => entry.id === pending.id)?.text.length ?? 0;
    const timer = window.setInterval(() => {
      length = Math.min(length + 8, pending.response.length);
      const text = pending.response.slice(0, length);
      const finished = length === pending.response.length;
      const next = finished ? steering.current.splice(0) : [];
      setState(current => ({
        ...current,
        status: finished && !next.length ? GlyphWorkbenchStatus.READY : GlyphWorkbenchStatus.STREAMING,
        transcript: current.transcript.map(entry => (entry.id === pending.id ? { ...entry, text } : entry)),
      }));
      if (finished) {
        window.clearInterval(timer);
        setPending(
          next.length
            ? { id: pending.id, response: `${pending.response}\n\nContinuing with your guidance: ${next.join('; ')}` }
            : undefined,
        );
      }
    }, 60);
    return () => window.clearInterval(timer);
  }, [pending]);

  const send: GlyphWorkbenchViewActions['send'] = async (text, attachments = [], options = {}) => {
    const turn = ++nextTurn.current;
    const id = `preview-assistant-${turn}`;
    const createdAt = new Date().toISOString();
    setState(current => ({
      ...current,
      status: GlyphWorkbenchStatus.STREAMING,
      transcript: [
        ...current.transcript,
        userMessageFixture({
          id: `preview-user-${turn}`,
          checkpointTurnId: id,
          createdAt,
          text,
          options,
          attachments: attachments.map(attachment => ({
            path: attachment.path,
            text: attachment.text,
            revision: attachment.contentRevision,
            ...(attachment.range ? { range: attachment.range } : {}),
          })),
        }),
        agentMessageFixture({ id, createdAt, text: '' }),
      ],
    }));
    setPending({
      id,
      response:
        'This is a simulated streaming response. Try resizing the pane, switching themes, or typing your next message while this reply arrives.\n\nCancel stops this reply; Send starts another. No model or workspace is connected.',
    });
  };

  return (
    <>
      {messageSettings && (
        <section aria-label="New Message Settings">
          <label>
            While responding{' '}
            <select
              value={followUpBehavior}
              onChange={event => setFollowUpBehavior(event.currentTarget.value as GlyphFollowUpBehavior)}
            >
              <option value={GlyphFollowUpBehavior.QUEUE}>Queue</option>
              <option value={GlyphFollowUpBehavior.SEND_IMMEDIATELY}>Send immediately</option>
            </select>
          </label>
          <button type="button" onClick={() => setMessageSettings(false)}>
            Done
          </button>
        </section>
      )}
      <WiredGlyphWorkbench
        state={state}
        actions={{
          ...previewActionsFixture(),
          composer,
          followUpBehavior,
          openMessageSettings: () => setMessageSettings(true),
          moveQueuedToNewChat: async id => {
            const message = composer.snapshot.queued.find(value => value.id === id);
            if (!message) return;
            const next = composerFixture({ document: message.document });
            composer.removeQueued(id);
            setComposer(next);
            setPending(undefined);
            steering.current = [];
            setState(current => ({
              ...current,
              selectedChatId: 'new-preview',
              status: GlyphWorkbenchStatus.READY,
              transcript: [],
            }));
          },
          branchChat: async (_chatId, turnId) => {
            setState(current => ({
              ...current,
              selectedChatId: 'branch',
              transcript: current.transcript.slice(0, current.transcript.findIndex(entry => entry.id === turnId) + 1),
              chats: [
                chatFixture({
                  id: 'branch',
                  title: 'Branched conversation',
                  accountProvider: 'preview',
                  accountId: 'preview',
                  modelSlug: 'preview',
                  updatedAt: new Date().toISOString(),
                  turnCount: 1,
                }),
              ],
            }));
          },
          restoreCheckpoint: async (_chatId, turnId) => {
            const index = state.transcript.findIndex(
              entry => entry.role === GlyphTranscriptRole.USER && entry.checkpointTurnId === turnId,
            );
            composer.setDraft(state.transcript[index]!.text);
            setState(current => ({ ...current, transcript: current.transcript.slice(0, index) }));
          },
          steer: async (text, attachments = [], options = {}) => {
            if (!pending) throw new Error('There is no active response to steer.');
            steering.current.push(text);
            const id = `preview-steering-${++nextTurn.current}`;
            setState(current => ({
              ...current,
              transcript: current.transcript.flatMap(entry =>
                entry.id === pending.id
                  ? [
                      userMessageFixture({
                        id,
                        text,
                        createdAt: new Date().toISOString(),
                        steering: true,
                        options,
                        attachments: attachments.map(attachment => ({
                          path: attachment.path,
                          text: attachment.text,
                          revision: attachment.contentRevision,
                        })),
                      }),
                      entry,
                    ]
                  : [entry],
              ),
            }));
          },
          send,
          sendImmediately: async (...args) => {
            steering.current = [];
            await send(...args);
          },
          cancel: () => {
            steering.current = [];
            setPending(undefined);
            setState(current => ({ ...current, status: GlyphWorkbenchStatus.READY }));
          },
        }}
      />
    </>
  );
}
