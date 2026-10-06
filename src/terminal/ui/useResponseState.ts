import { useMemo } from 'react';
import type { ChatResponsePart } from '../../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';

/** Display-ready response sections after adjacent stream fragments are combined. */
export interface ResponseState {
  sections: readonly ChatResponsePart[];
}

export function useResponseState(parts: readonly ChatResponsePart[]): ResponseState {
  return useMemo(() => ({ sections: combineAdjacentSections(parts) }), [parts]);
}

function combineAdjacentSections(parts: readonly ChatResponsePart[]): ChatResponsePart[] {
  const sections: ChatResponsePart[] = [];
  for (const part of parts) {
    const previous = sections.at(-1);
    if (part.type === ChatResponsePartType.TEXT && previous?.type === ChatResponsePartType.TEXT) {
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
