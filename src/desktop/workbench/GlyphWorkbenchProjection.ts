import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphDesktopSnapshot } from '#src/desktop/protocol/events/GlyphDesktopSnapshot.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphResponseDeltaKind } from '#src/desktop/protocol/events/GlyphResponseDelta.js';
import { GlyphHostStatus } from '#src/desktop/protocol/events/GlyphHostStatus.js';
import type { GlyphUsage } from '#src/desktop/protocol/events/GlyphUsage.js';

/**
 * Rebuilds renderer state from authoritative snapshots and ordered host events.
 * Keeping this independent of the view makes reconnect recovery use the same
 * rules as live streaming, including pending human decisions.
 */
export class GlyphWorkbenchProjection {
  private snapshot: GlyphDesktopSnapshot = {
    accounts: [],
    models: [],
    chats: [],
    runs: [],
    proposals: [],
    ownerWindowId: '',
    readOnly: true,
    sequence: 0,
  };
  private usageByChat: Record<string, GlyphUsage> = {};
  status = GlyphHostStatus.DISCONNECTED;
  readonly diagnostics: string[] = [];

  get state(): GlyphDesktopSnapshot {
    return this.snapshot;
  }
  get usage(): Readonly<Record<string, GlyphUsage>> {
    return this.usageByChat;
  }

  /** A snapshot replaces old collections so removed or completed work cannot linger. */
  accept(event: GlyphHostEvent): void {
    switch (event.type) {
      case GlyphHostEventType.AGENT_REVIEW_CHANGED:
        this.snapshot = {
          ...this.snapshot,
          agentReviews: upsert(this.snapshot.agentReviews ?? [], event.review, value => value.id),
        };
        return;
      case GlyphHostEventType.INITIAL_STATE: {
        this.snapshot = event.state;
        this.usageByChat = { ...event.state.usageByChat };
        this.status = GlyphHostStatus.READY;
        return;
      }
      case GlyphHostEventType.INSTRUCTION_SOURCES_CHANGED: {
        this.snapshot = { ...this.snapshot, instructionSources: event.sources };
        return;
      }
      case GlyphHostEventType.SHELL_SESSIONS: {
        this.snapshot = { ...this.snapshot, shells: event.shells };
        return;
      }
      case GlyphHostEventType.CHAT_UPDATED: {
        this.snapshot = { ...this.snapshot, chats: upsert(this.snapshot.chats, event.chat, value => value.id) };
        return;
      }
      case GlyphHostEventType.CHAT_RESTORED: {
        this.snapshot = {
          ...this.snapshot,
          runs: [...this.snapshot.runs.filter(run => run.chatId !== event.chatId), ...event.runs],
        };
        return;
      }
      case GlyphHostEventType.RUN_STATE: {
        this.setRun(event.run);
        return;
      }
      case GlyphHostEventType.PROPOSAL_CHANGED: {
        this.snapshot = {
          ...this.snapshot,
          proposals: upsert(this.snapshot.proposals, { ...event.proposal, chatId: event.chatId }, value => value.id),
        };
        return;
      }
      case GlyphHostEventType.USAGE: {
        this.usageByChat = { ...this.usageByChat, [event.chatId]: event.usage };
        return;
      }
      case GlyphHostEventType.HOST_STATUS: {
        this.status = event.status;
        if (event.status === GlyphHostStatus.DISCONNECTED) {
          this.snapshot = {
            ...this.snapshot,
            shells: [],
            runs: this.snapshot.runs.map(run => ({
              ...run,
              tools: run.tools.map(tool =>
                tool.shell
                  ? {
                      ...tool,
                      shell: {
                        ...tool.shell,
                        live: false,
                        running: false,
                        ...(tool.shell.running ? { error: 'Shell interrupted when the host disconnected.' } : {}),
                      },
                    }
                  : tool,
              ),
            })),
          };
        }
        if (event.status === GlyphHostStatus.DISCONNECTED) {
          // Streaming and human-decision waits cannot remain actionable after
          // their host disappears. Preserve the partial answer until recovery.
          for (const run of this.snapshot.runs) {
            if (
              ![
                GlyphRunStatus.STREAMING,
                GlyphRunStatus.WAITING_FOR_QUESTION,
                GlyphRunStatus.WAITING_FOR_APPROVAL,
              ].includes(run.status)
            )
              continue;
            const { question: _question, approval: _approval, ...settled } = run;
            this.setRun({ ...settled, status: GlyphRunStatus.INTERRUPTED });
          }
        }
        if (event.message !== undefined && event.message !== '') this.diagnostics.push(event.message);
        return;
      }
      case GlyphHostEventType.ERROR: {
        if (event.requestId === undefined || event.requestId === '') this.diagnostics.push(event.error.message);
        break;
      }
      case GlyphHostEventType.COMMAND_RESULT:
      case GlyphHostEventType.PROPOSAL_PREVIEW:
        return;
      case GlyphHostEventType.RESPONSE_DELTA: {
        const run = this.run(event.chatId, event.runId);
        switch (event.delta.kind) {
          case GlyphResponseDeltaKind.TEXT:
            this.setRun({ ...run, text: run.text + event.delta.value });
            break;
          case GlyphResponseDeltaKind.REASONING:
            this.setRun({ ...run, reasoning: run.reasoning + event.delta.value });
            break;
          case GlyphResponseDeltaKind.DIAGNOSTIC:
            this.diagnostics.push(event.delta.value);
            break;
        }
        return;
      }
      case GlyphHostEventType.TOOL_ACTIVITY: {
        const run = this.run(event.chatId, event.runId);
        this.setRun({ ...run, tools: upsert(run.tools, event.activity, value => value.id) });
        return;
      }
      case GlyphHostEventType.QUESTION: {
        const run = this.run(event.chatId, event.runId);
        this.setRun({ ...run, status: GlyphRunStatus.WAITING_FOR_QUESTION, question: event.question });
        return;
      }
      case GlyphHostEventType.APPROVAL: {
        const run = this.run(event.chatId, event.runId);
        this.setRun({
          ...run,
          status: GlyphRunStatus.WAITING_FOR_APPROVAL,
          approval: event.approval,
          ...(event.approval.modeSwap ? { modeSwaps: [...(run.modeSwaps ?? []), event.approval.modeSwap] } : {}),
        });
      }
    }
  }

  private run(chatId: string, runId: string): GlyphRunProjection {
    return (
      this.snapshot.runs.find(value => value.chatId === chatId && value.runId === runId) ?? {
        chatId,
        runId,
        status: GlyphRunStatus.STREAMING,
        text: '',
        reasoning: '',
        tools: [],
      }
    );
  }

  private setRun(run: GlyphRunProjection): void {
    this.snapshot = {
      ...this.snapshot,
      runs: upsert(this.snapshot.runs, run, value => `${value.chatId}\0${value.runId}`),
    };
  }
}

function upsert<T>(values: readonly T[], value: T, key: (item: T) => string): readonly T[] {
  if (!values.some(item => key(item) === key(value))) return [...values, value];
  return values.map(item => (key(item) === key(value) ? value : item));
}
