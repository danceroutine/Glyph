import type { Question } from './Question.ts';

/** Provider-independent form that a model asks the host to present. */
export interface QuestionForm {
  readonly title?: string;
  readonly questions: readonly Question[];
}
