import { z } from 'zod';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';

export const questionAnswersSchema = z.object({
  answers: z.array(
    z.discriminatedUnion('type', [
      z.object({ questionId: z.string(), type: z.literal(QuestionAnswerType.OTHER), text: z.string().trim().min(1) }),
      z.object({
        questionId: z.string(),
        type: z.literal(QuestionAnswerType.SELECTION),
        optionIds: z.array(z.string()).min(1),
      }),
    ]),
  ),
});
