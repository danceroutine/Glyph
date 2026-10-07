import type { QuestionForm } from './QuestionForm.ts';
import type { QuestionFormResult } from './QuestionFormResult.ts';

/**
 * Host boundary for interactive model questions. Core tool execution depends
 * on this port without knowing whether a terminal, IDE, or web UI presents it.
 */
export interface QuestionPresenter {
  present(form: QuestionForm, signal: AbortSignal): Promise<QuestionFormResult>;
}
