import type { QuestionForm } from '#src/interaction/questions/QuestionForm.js';
import type { QuestionFormResult } from '#src/interaction/questions/QuestionFormResult.js';

/** Renderer-owned question interaction consumed by the wired form. */
export interface QuestionFormRequest {
  readonly id: number;
  readonly form: QuestionForm;
  readonly complete: (result: QuestionFormResult) => void;
  readonly interrupt: () => void;
}
