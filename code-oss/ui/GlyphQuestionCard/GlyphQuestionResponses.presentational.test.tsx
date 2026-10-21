import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { GlyphQuestionResponses } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionResponses.presentational.tsx';

afterEach(cleanup);

describe(GlyphQuestionResponses, () => {
  it('lists each submitted answer under its question', () => {
    render(
      <GlyphQuestionResponses
        response={{
          id: 'response',
          answers: [
            { question: 'Color?', answer: 'Blue' },
            { question: 'Tools?', answer: 'Git, npm' },
          ],
        }}
      />,
    );

    const section = screen.getByRole('region', { name: 'Submitted answers' });
    expect([...section.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['Color?', 'Tools?']);
    expect([...section.querySelectorAll('dd')].map(detail => detail.textContent)).toEqual(['Blue', 'Git, npm']);
  });
});
