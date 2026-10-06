import type { ReactElement, ReactNode } from 'react';
import type { ChatResponsePart } from '../../chat/ChatResponsePart.ts';
import { ResponsePresentational } from './Response.presentational.tsx';
import { useResponseState } from './useResponseState.ts';

export interface ResponseWiredProps {
  parts: readonly ChatResponsePart[];
  footer?: ReactNode;
}

export function ResponseWired({ parts, footer }: ResponseWiredProps): ReactElement {
  const state = useResponseState(parts);
  return <ResponsePresentational {...state} footer={footer} />;
}
