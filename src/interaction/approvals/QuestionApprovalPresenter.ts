import type { Approval } from './Approval.ts';
import type { ApprovalCapability } from './ApprovalCapability.ts';
import type { ApprovalPresenter, ApprovalSelection } from './ApprovalPresenter.ts';
import type { QuestionPresenter } from '#src/interaction/questions/QuestionPresenter.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';

/** Renders host-defined choices; free text can never create permission. */
export class QuestionApprovalPresenter<C extends ApprovalCapability> implements ApprovalPresenter<C> {
  constructor(private readonly questions: QuestionPresenter) {}
  async presentApproval(approval: Approval<C>, signal: AbortSignal, displayed: () => void): Promise<ApprovalSelection> {
    displayed();
    const result = await this.questions.present(
      {
        title: approval.request.title,
        questions: [
          {
            id: 'approval',
            prompt: approval.request.detail,
            allowMultiple: false,
            options: approval.request.choices.map(choice => ({
              id: choice.id,
              label: `${choice.label} — ${choice.description}`,
            })),
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();
    const answer = result.answers[0];
    if (
      result.answers.length !== 1 ||
      answer?.questionId !== 'approval' ||
      answer.type !== QuestionAnswerType.SELECTION ||
      answer.optionIds.length !== 1
    )
      throw new Error('Choose one of the advertised approval options.');
    const choiceId = answer.optionIds[0]!;
    approval.validateChoice(choiceId);
    return { approvalId: approval.id, choiceId };
  }
}
