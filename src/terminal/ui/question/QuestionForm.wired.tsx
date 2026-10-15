import type { ReactElement } from 'react';
import { QuestionForm } from './QuestionForm.presentational.tsx';
import type { QuestionFormRequest } from './QuestionFormRequest.ts';
import { useQuestionFormState } from './useQuestionFormState.ts';

export interface WiredQuestionFormProps {
  readonly request: QuestionFormRequest;
  readonly active?: boolean;
}

export function WiredQuestionForm({ active = true, request }: WiredQuestionFormProps): ReactElement {
  // Consecutive requests can replace one another without an empty render in
  // between. Their answers, input guards, and cursor state must not be reused.
  return <QuestionFormInteraction key={request.id} active={active} request={request} />;
}

function QuestionFormInteraction({ active = true, request }: WiredQuestionFormProps): ReactElement {
  const state = useQuestionFormState({ request, active });
  return <QuestionForm {...state} />;
}
