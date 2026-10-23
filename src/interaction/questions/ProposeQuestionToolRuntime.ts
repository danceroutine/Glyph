import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Tool } from '#src/tools/Tool.js';
import { z } from 'zod';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import type { ToolSource } from '#src/tools/ToolSource.js';
import type { QuestionAnswer } from './QuestionAnswer.ts';
import { QuestionAnswerType } from './QuestionAnswerType.ts';
import type { QuestionForm } from './QuestionForm.ts';
import type { QuestionPresenter } from './QuestionPresenter.ts';
import { QuestionToolName } from './QuestionToolName.ts';
import { QuestionToolNamespace } from './QuestionToolNamespace.ts';
import { isRecord } from '#src/shared/validators/isRecord.js';
import { isEnumValue } from '#src/shared/validators/isEnumValue.js';
import { createNullPrototypeRecord } from '#src/shared/mappers/createNullPrototypeRecord.js';

const identifierSchema = z.string().min(1).max(80);
const questionOptionSchema = z
  .object({
    id: identifierSchema.describe('Stable identifier returned when the human selects this option.'),
    label: z.string().min(1).max(240).describe('Human-readable option label.'),
  })
  .strict();
const questionSchema = z
  .object({
    id: identifierSchema.describe('Stable identifier used as the answer key.'),
    prompt: z.string().min(1).max(1_000).describe('The question shown to the human.'),
    options: z.array(questionOptionSchema).min(2),
    allow_multiple: z
      .boolean()
      .nullable()
      .describe('Whether the human may select more than one option. Pass null for a single selection.'),
  })
  .strict()
  .superRefine(({ options }, context) => {
    addDuplicateIssues(
      options.map(option => option.id),
      context,
      ['options'],
      'Option identifiers must be unique within a question.',
    );
  });
const proposeQuestionArgumentsSchema = z
  .object({
    title: z.string().min(1).max(160).nullable().describe('Optional form title, or null when no title is needed.'),
    questions: z.array(questionSchema).min(1),
  })
  .strict()
  .superRefine(({ questions }, context) => {
    addDuplicateIssues(
      questions.map(question => question.id),
      context,
      ['questions'],
      'Question identifiers must be unique within the form.',
    );
  });
const executableProposeQuestionArgumentsSchema = z.preprocess(value => {
  if (!isRecord(value)) return value;
  const entries: unknown = value.questions;
  const questions = Array.isArray(entries)
    ? (entries satisfies unknown[]).map((question: unknown) =>
        isRecord(question) && !('allow_multiple' in question) ? { ...question, allow_multiple: null } : question,
      )
    : value.questions;
  return { ...value, title: 'title' in value ? value.title : null, questions };
}, proposeQuestionArgumentsSchema);

/** Executes the provider-neutral proposed-question capability through a host presenter. */
export class ProposeQuestionToolRuntime implements ToolSource {
  readonly tools: readonly Tool[] = [
    {
      namespace: QuestionToolNamespace.INTERACTION,
      name: QuestionToolName.PROPOSE_QUESTION,
      allowedModes: [AgentModeID.AGENT, AgentModeID.PLAN],
      description:
        'Propose a question to the human only when missing preferences or requirements would materially change the result. Combine related questions into one call, use concise mutually distinct options, and do not request facts available through project tools. The host always adds an Other option for free-text input.',
      inputKind: ToolInputKind.JSON,
      parameters: jsonSchema(proposeQuestionArgumentsSchema),
      validateInput: input => {
        executableProposeQuestionArgumentsSchema.parse(JSON.parse(input));
      },
      execute: (input, signal) => this.execute(QuestionToolName.PROPOSE_QUESTION, input, signal),
    },
  ];

  constructor(private readonly presenter: QuestionPresenter) {}

  async execute(name: string, input: string, signal = new AbortController().signal): Promise<string> {
    if (!isEnumValue(QuestionToolName, name) || name !== QuestionToolName.PROPOSE_QUESTION)
      throw new Error(`Unknown interaction tool: ${name}`);
    try {
      const form = toQuestionForm(executableProposeQuestionArgumentsSchema.parse(JSON.parse(input)));
      const result = await this.presenter.present(form, signal);
      return JSON.stringify({ answers: serializeAnswers(form, result.answers) });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return JSON.stringify({
        error: {
          code: error instanceof z.ZodError || error instanceof SyntaxError ? 'MALFORMED' : 'QUESTION_FAILED',
          message: error instanceof Error ? error.message : 'Question presentation failed.',
        },
      });
    }
  }
}

function toQuestionForm({ title, questions }: z.infer<typeof proposeQuestionArgumentsSchema>): QuestionForm {
  return {
    ...(title === null ? {} : { title }),
    questions: questions.map(({ allow_multiple: allowMultiple, ...question }) => ({
      ...question,
      allowMultiple: allowMultiple ?? false,
    })),
  };
}

function serializeAnswers(
  form: QuestionForm,
  answers: readonly QuestionAnswer[],
): Record<string, string | readonly string[]> {
  const byQuestion = new Map(answers.map(answer => [answer.questionId, answer]));
  if (byQuestion.size !== answers.length) throw new Error('The question presenter returned duplicate answers.');
  const serialized = createNullPrototypeRecord<string | readonly string[]>();
  for (const question of form.questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) throw new Error(`The question presenter did not answer ${question.id}.`);
    if (answer.type === QuestionAnswerType.OTHER) {
      const text = answer.text.trim();
      if (!text) throw new Error(`The Other answer for ${question.id} is empty.`);
      serialized[question.id] = text;
      continue;
    }
    const selected = [...new Set(answer.optionIds)];
    if (selected.length === 0) throw new Error(`The question presenter selected no option for ${question.id}.`);
    if (!question.allowMultiple && selected.length !== 1) {
      throw new Error(`The question presenter selected multiple options for single-choice question ${question.id}.`);
    }
    const optionIds = new Set(question.options.map(option => option.id));
    if (selected.some(optionId => !optionIds.has(optionId))) {
      throw new Error(`The question presenter selected an unknown option for ${question.id}.`);
    }
    serialized[question.id] = question.allowMultiple ? selected : selected[0]!;
  }
  if (byQuestion.size !== form.questions.length) throw new Error('The question presenter returned an unknown answer.');
  return serialized;
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.core.$RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  if (new Set(values).size === values.length) return;
  context.addIssue({ code: 'custom', path, message });
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...parameters } = z.toJSONSchema(schema, { target: 'draft-7' });
  return parameters;
}
