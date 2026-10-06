import { useMemo } from 'react';
import { useAnimation, useWindowSize } from 'ink';
import type { ChatResponsePart } from '../../../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../../../chat/ChatResponsePartType.ts';
import { ToolActivityPhase } from '../../../chat/ToolActivityPhase.ts';

/** Display-ready response sections after adjacent stream fragments are combined. */
export interface ResponseState {
  sections: readonly ChatResponsePart[];
  pendingFrame?: number;
  toolFrame?: number;
  messageWidth: number;
}

export function useResponseState(parts: readonly ChatResponsePart[], live: boolean): ResponseState {
  const { columns } = useWindowSize();
  const messageWidth = Math.max(3, Math.floor(columns * 0.8));
  const isPending = live && parts.length === 0;
  const sections = useMemo(
    () => combineAdjacentSections(parts).filter(part => live || part.type !== ChatResponsePartType.REASONING_SUMMARY),
    [live, parts],
  );
  const hasRunningTool = sections.some(
    section => section.type === ChatResponsePartType.TOOL && section.activity.phase === ToolActivityPhase.STARTED,
  );
  const { frame: pendingFrame } = useAnimation({ interval: 220, isActive: isPending });
  const { frame: toolFrame } = useAnimation({ interval: 80, isActive: hasRunningTool });
  return useMemo(
    () => ({
      sections,
      messageWidth,
      ...(isPending ? { pendingFrame } : {}),
      ...(hasRunningTool ? { toolFrame } : {}),
    }),
    [hasRunningTool, isPending, messageWidth, pendingFrame, sections, toolFrame],
  );
}

function combineAdjacentSections(parts: readonly ChatResponsePart[]): ChatResponsePart[] {
  const sections: ChatResponsePart[] = [];
  for (const part of parts) {
    const previous = sections.at(-1);
    if (part.type === ChatResponsePartType.TOOL) {
      const existing = sections.findIndex(
        section => section.type === ChatResponsePartType.TOOL && section.activity.callId === part.activity.callId,
      );
      if (existing >= 0) sections[existing] = part;
      else sections.push(part);
    } else if (part.type === ChatResponsePartType.TEXT && previous?.type === ChatResponsePartType.TEXT) {
      sections[sections.length - 1] = { type: part.type, value: previous.value + part.value };
    } else if (
      part.type === ChatResponsePartType.REASONING_SUMMARY &&
      previous?.type === ChatResponsePartType.REASONING_SUMMARY
    ) {
      sections[sections.length - 1] = { type: part.type, value: previous.value + part.value };
    } else {
      sections.push(part);
    }
  }
  return sections;
}
