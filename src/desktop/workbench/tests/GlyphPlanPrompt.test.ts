import { describe, expect, it } from 'vitest';
import {
  GlyphPlanPromptIntent,
  toGlyphPlanBuildLead,
  toGlyphPlanPrompt,
} from '#src/desktop/workbench/GlyphPlanPrompt.js';

describe(toGlyphPlanPrompt, () => {
  it('asks a builder to keep the plan’s existing todos current', () => {
    const plan = {
      id: 'plan',
      revision: 2,
      title: 'Queue messages',
      summary: '',
      markdown: '# Queue messages',
      todos: [
        { id: 'state', text: 'Add state', completed: true },
        { id: 'ui', text: 'Show the queue', completed: false },
      ],
      agents: [],
    };

    expect(toGlyphPlanPrompt(GlyphPlanPromptIntent.BUILD, plan)).toBe(
      [
        'Build this approved plan: Queue messages (plan plan, revision 2).',
        '# Queue messages',
        'Todos:\n- [x] Add state (todo id: state)\n- [ ] Show the queue (todo id: ui)',
        'These todos are already on your todo list. Update them by ID with update_todos as you work.',
      ].join('\n\n'),
    );
  });

  it('asks a reviewer to read the todos without tracking them', () => {
    const plan = {
      id: 'plan',
      revision: 1,
      title: 'Queue messages',
      summary: '',
      markdown: '# Queue messages',
      todos: [{ id: 'ui', text: 'Show the queue', completed: false }],
      agents: [],
    };

    expect(toGlyphPlanPrompt(GlyphPlanPromptIntent.REVIEW, plan)).toBe(
      'Review this plan: Queue messages (plan plan, revision 1).\n\n# Queue messages\n\nTodos:\n- [ ] Show the queue',
    );
  });
});

describe(toGlyphPlanBuildLead, () => {
  it('keeps only what the person wrote before the build order', () => {
    const build = { planId: 'plan', revision: 1, title: 'Queue messages', sourceChatId: 'chat', todos: [] };

    expect(
      toGlyphPlanBuildLead(
        'Prefer small commits.\n\nBuild this approved plan: Queue messages (plan plan, revision 1).\n\n# Plan',
        build,
      ),
    ).toBe('Prefer small commits.');
    expect(toGlyphPlanBuildLead('Build this approved plan: Queue messages (plan plan, revision 1).', build)).toBe('');
  });
});
