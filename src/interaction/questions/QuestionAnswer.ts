import { QuestionAnswerType } from './QuestionAnswerType.ts';

export type QuestionAnswer = SelectedQuestionAnswer | OtherQuestionAnswer;

export interface SelectedQuestionAnswer {
  readonly questionId: string;
  readonly type: QuestionAnswerType.SELECTION;
  readonly optionIds: readonly string[];
}

export interface OtherQuestionAnswer {
  readonly questionId: string;
  readonly type: QuestionAnswerType.OTHER;
  readonly text: string;
}
