import type { QuestionOption } from './QuestionOption.ts';

/** One multiple-choice question presented to the human by the host. */
export interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly allowMultiple: boolean;
}
