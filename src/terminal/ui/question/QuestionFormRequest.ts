import type { QuestionForm } from '../../../interaction/questions/QuestionForm.ts';
import type { QuestionFormResult } from '../../../interaction/questions/QuestionFormResult.ts';

/** Renderer-owned question interaction consumed by the wired form. */
export interface QuestionFormRequest {
  readonly id: number;
  readonly form: QuestionForm;
  readonly complete: (result: QuestionFormResult) => void;
  readonly interrupt: () => void;
}
