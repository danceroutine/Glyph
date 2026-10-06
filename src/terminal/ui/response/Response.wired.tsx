import type { ReactElement, ReactNode } from 'react';
import type { ChatResponsePart } from '../../../chat/ChatResponsePart.ts';
import { Response } from './Response.presentational.tsx';
import { useResponseState } from './useResponseState.ts';

export interface WiredResponseProps {
  parts: readonly ChatResponsePart[];
  footer?: ReactNode;
}

export function WiredResponse({ parts, footer }: WiredResponseProps): ReactElement {
  const state = useResponseState(parts, footer === undefined);
  return <Response {...state} footer={footer} />;
}
