import type { ReactElement } from 'react';
import { QuestionForm } from './QuestionForm.presentational.tsx';
import type { QuestionFormRequest } from './QuestionFormRequest.ts';
import { useQuestionFormState } from './useQuestionFormState.ts';

export interface WiredQuestionFormProps {
  readonly request: QuestionFormRequest;
  readonly active?: boolean;
}

export function WiredQuestionForm({ active = true, request }: WiredQuestionFormProps): ReactElement {
  const state = useQuestionFormState({ request, active });
  return <QuestionForm {...state} />;
}
