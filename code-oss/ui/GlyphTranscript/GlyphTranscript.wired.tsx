import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { GlyphFileChanges } from '#code-oss/ui/GlyphFileChanges/GlyphFileChanges.tsx';
import type { ComponentChildren } from 'preact';
import type { GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import {
  GlyphAgentMessageWithState,
  type GlyphMessageActions,
} from '#code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.wired.tsx';
import { WiredGlyphTranscriptContent } from './GlyphTranscriptContent.wired.tsx';
import { GlyphTranscript, GlyphTranscriptMessage } from './GlyphTranscript.presentational.tsx';
import { GlyphPlanBuildMessage } from './GlyphPlanBuildMessage.presentational.tsx';
import { useGlyphTranscriptState, type GlyphTranscriptStateOptions } from './useGlyphTranscriptState.ts';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

export interface WiredGlyphTranscriptProps extends GlyphTranscriptStateOptions {
  readonly proposals?: readonly GlyphProposalSummary[];
  readonly plans?: ComponentChildren;
  readonly chatId?: string;
  readonly pendingApproval?: GlyphRunProjection;
  readonly actions?: GlyphMessageActions;
  readonly readOnly?: boolean;
  readonly buildingPlanIds?: readonly string[];
  readonly openPlan?: (sourceChatId: string, planId: string) => void;
}

export function WiredGlyphTranscript({
  entries,
  plans,
  proposals = [],
  chatId,
  pendingApproval,
  actions,
  readOnly = false,
  buildingPlanIds = [],
  openPlan,
}: WiredGlyphTranscriptProps) {
  const activeBuilds = new Set(
    buildingPlanIds.flatMap(planId => {
      const entry = entries.findLast(
        value => value.role === GlyphTranscriptRole.USER && value.options?.planBuild?.planId === planId,
      );
      return entry ? [entry.id] : [];
    }),
  );
  const state = useGlyphTranscriptState({
    entries,
    context: actions?.context,
    openLink: actions?.openLink,
    copyText: actions?.copyText,
    branch:
      !readOnly && chatId !== undefined && chatId !== '' && actions?.branchChat
        ? turnId => actions.branchChat!(chatId, turnId)
        : undefined,
    restore:
      !readOnly && chatId !== undefined && chatId !== '' && actions?.restoreCheckpoint
        ? turnId => actions.restoreCheckpoint!(chatId, turnId)
        : undefined,
  });
  return (
    <GlyphTranscript transcript={state.transcript} plans={plans}>
      {state.entries.map(entry => {
        const build = entry.role === GlyphTranscriptRole.USER ? entry.options?.planBuild : undefined;
        return entry.role === GlyphTranscriptRole.ASSISTANT ? (
          <GlyphAgentMessageWithState
            key={entry.id}
            entry={entry}
            changes={proposals
              .filter(
                proposal =>
                  proposal.chatId === chatId &&
                  entry.progress?.tools.some(tool => tool.summary?.includes(proposal.id) === true) === true,
              )
              .map(proposal => (
                <GlyphFileChanges
                  key={proposal.id}
                  files={proposal.files}
                  review={fileId => {
                    if (chatId !== undefined && chatId !== '')
                      void actions?.reviewProposalFile?.(chatId, proposal.id, fileId);
                  }}
                />
              ))}
            chatId={chatId}
            pendingApproval={pendingApproval}
            actions={actions}
            readOnly={readOnly}
          />
        ) : build ? (
          <GlyphPlanBuildMessage
            key={entry.id}
            entry={entry}
            build={build}
            building={activeBuilds.has(entry.id)}
            content={<WiredGlyphTranscriptContent entry={entry} />}
            openPlan={
              openPlan &&
              (() => {
                openPlan(build.sourceChatId, build.planId);
              })
            }
          />
        ) : (
          <GlyphTranscriptMessage
            key={entry.id}
            entry={entry}
            content={<WiredGlyphTranscriptContent entry={entry} />}
          />
        );
      })}
    </GlyphTranscript>
  );
}
