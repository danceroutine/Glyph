import type { QuestionAnswer } from './QuestionAnswer.ts';

/** Complete, ordered answers returned by a host question presenter. */
export interface QuestionFormResult {
  readonly answers: readonly QuestionAnswer[];
}
