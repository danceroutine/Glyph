import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphQuestionCard } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionCard.presentational.tsx';
import type { GlyphQuestionCardProps } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionCard.presentational.tsx';

afterEach(cleanup);

type CardQuestion = GlyphQuestionCardProps['questions'][number];

const cardQuestion = (overrides: Partial<CardQuestion> = {}): CardQuestion => ({
  question: {
    id: 'color',
    prompt: 'Color?',
    allowMultiple: false,
    options: [
      { id: 'red', label: 'Red' },
      { id: 'blue', label: 'Blue' },
    ],
  },
  inputName: 'request:color',
  fieldset: vi.fn(),
  activate: vi.fn(),
  other: false,
  selectedOptionIds: [],
  otherText: '',
  selectOption: vi.fn(),
  enterOther: vi.fn(),
  updateOther: vi.fn(),
  ...overrides,
});

const cardProps = (overrides: Partial<GlyphQuestionCardProps> = {}): GlyphQuestionCardProps => ({
  title: 'Setup',
  questions: [cardQuestion()],
  questionNumber: 1,
  questionCount: 1,
  viewport: createRef<HTMLDivElement>(),
  trackScroll: vi.fn(),
  disabled: false,
  pending: false,
  error: undefined,
  valid: true,
  continueForm: vi.fn(),
  cancel: vi.fn(),
  back: vi.fn(),
  next: vi.fn(),
  ...overrides,
});

describe(GlyphQuestionCard, () => {
  it('asks a single-choice question with lettered options and a written alternative', () => {
    const question = cardQuestion({ selectedOptionIds: ['blue'] });
    render(<GlyphQuestionCard {...cardProps({ questions: [question] })} />);

    expect(screen.getByRole('form', { name: 'Questions' }).getAttribute('aria-busy')).toBe('false');
    expect(screen.getByRole('heading', { name: 'Setup' })).toBeTruthy();
    const group = screen.getByRole('group', { name: '1. Color?' });
    expect(group.textContent).toContain('ARed');
    expect(group.textContent).toContain('BBlue');
    expect(group.textContent).toContain('COther…');
    expect(screen.queryByText('Choose one or more.')).toBeNull();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map(radio => [radio.name, radio.checked])).toEqual([
      ['request:color', false],
      ['request:color', true],
      ['request:color', false],
    ]);
    expect(screen.queryByRole('textbox', { name: 'Your answer' })).toBeNull();
    expect(question.fieldset).toHaveBeenCalledWith(group);

    fireEvent.click(radios[0]!);
    fireEvent.click(radios[2]!);
    radios[0]!.focus();

    expect(question.selectOption).toHaveBeenCalledWith('red', true);
    expect(question.enterOther).toHaveBeenCalledOnce();
    expect(question.activate).toHaveBeenCalled();
  });

  it('asks a multiple-choice question with checkboxes', () => {
    const question = cardQuestion({
      question: { id: 'tools', prompt: 'Tools?', allowMultiple: true, options: [{ id: 'git', label: 'Git' }] },
      selectedOptionIds: ['git'],
    });
    render(<GlyphQuestionCard {...cardProps({ questions: [question] })} />);

    expect(screen.getByText('Choose one or more.')).toBeTruthy();
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);

    expect(question.selectOption).toHaveBeenCalledWith('git', false);
  });

  it('numbers options beyond the alphabet', () => {
    const options = Array.from({ length: 27 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` }));
    render(
      <GlyphQuestionCard
        {...cardProps({
          questions: [cardQuestion({ question: { id: 'many', prompt: 'Many?', allowMultiple: false, options } })],
        })}
      />,
    );

    const badges = [...screen.getByRole('group').querySelectorAll('label > span[aria-hidden="true"]')].map(
      badge => badge.textContent,
    );
    expect(badges.slice(24)).toEqual(['Y', 'Z', '27', '28']);
  });

  it('numbers the written alternative once the options use the whole alphabet', () => {
    const options = Array.from({ length: 26 }, (_, index) => ({ id: `o${index}`, label: `Option ${index}` }));
    render(
      <GlyphQuestionCard
        {...cardProps({
          questions: [cardQuestion({ question: { id: 'many', prompt: 'Many?', allowMultiple: false, options } })],
        })}
      />,
    );

    const badges = [...screen.getByRole('group').querySelectorAll('label > span[aria-hidden="true"]')];
    expect(badges.at(-1)?.textContent).toBe('27');
  });

  it('edits a written answer', () => {
    const question = cardQuestion({ other: true, otherText: 'Green' });
    render(<GlyphQuestionCard {...cardProps({ questions: [question] })} />);
    const answer = screen.getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement;
    expect(answer.value).toBe('Green');
    expect((screen.getAllByRole('radio').at(-1) as HTMLInputElement).checked).toBe(true);

    fireEvent.input(answer, { target: { value: 'Teal' } });

    expect(question.updateOther).toHaveBeenCalledWith('Teal');
  });

  it('asks an open question without options', () => {
    render(
      <GlyphQuestionCard
        {...cardProps({
          questions: [
            cardQuestion({ question: { id: 'q', prompt: 'Why?', allowMultiple: false, options: [] }, other: true }),
          ],
        })}
      />,
    );

    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
  });

  it('moves between questions and shows its position', () => {
    const props = cardProps({
      questions: [
        cardQuestion(),
        cardQuestion({ question: { id: 'b', prompt: 'B?', allowMultiple: false, options: [] } }),
      ],
      questionNumber: 2,
      questionCount: 3,
    });
    render(<GlyphQuestionCard {...props} />);

    expect(screen.getByRole('group', { name: '2. B?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous question' }).parentElement?.textContent).toContain('2 of 3');

    fireEvent.click(screen.getByRole('button', { name: 'Previous question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.scroll(props.viewport.current!);

    expect(props.back).toHaveBeenCalledTimes(2);
    expect(props.next).toHaveBeenCalledOnce();
    expect(props.trackScroll).toHaveBeenCalledOnce();
    expect(props.viewport.current?.classList.contains('glyph-question-scroll')).toBe(true);
  });

  it('cannot move past the first or last question', () => {
    render(<GlyphQuestionCard {...cardProps()} />);

    expect((screen.getByRole('button', { name: 'Previous question' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Next question' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('continues with valid answers and cancels the turn', () => {
    const props = cardProps();
    render(<GlyphQuestionCard {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel turn' }));

    expect(props.continueForm).toHaveBeenCalledOnce();
    expect(props.cancel).toHaveBeenCalledOnce();
  });

  it('cannot continue without a valid answer', () => {
    render(<GlyphQuestionCard {...cardProps({ valid: false })} />);

    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('becomes busy and unavailable while submitting', () => {
    render(<GlyphQuestionCard {...cardProps({ pending: true, questionNumber: 2, questionCount: 3 })} />);

    expect(screen.getByRole('form', { name: 'Questions' }).getAttribute('aria-busy')).toBe('true');
    for (const name of ['Submitting…', 'Cancel turn', 'Back', 'Previous question', 'Next question'])
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('directs answers to the window that owns the chat', () => {
    render(<GlyphQuestionCard {...cardProps({ disabled: true })} />);

    expect(screen.getByText('Answer in the window that owns this chat.')).toBeTruthy();
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('shows why the last submission failed', () => {
    render(<GlyphQuestionCard {...cardProps({ error: 'Expired' })} />);

    expect(screen.getByRole('alert').textContent).toBe('Expired');
  });
});
