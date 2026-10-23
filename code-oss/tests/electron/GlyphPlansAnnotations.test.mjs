import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { editToolOutput, parseJson } from './ProviderPayloads.mjs';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */
const reloadsWindow = isolatedLaunch('reloads the window');
const plan = {
  id: null,
  expectedRevision: null,
  title: 'Queue messages',
  summary: 'Queue prompts until the active run finishes.',
  markdown:
    '# Queue messages\n\nKeep exact ordering and preserve failed messages.\n\n## Flow\n\n```mermaid\nflowchart LR\nComposer --> Queue\nQueue --> Send\n```\n\n## Changes\n\n- Add a queue.\n- Preserve drafts.',
  todos: [{ id: 'queue', text: 'Add queue state', completed: false }],
};
/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 */
async function createPlan(glyph, provider) {
  await glyph.page.getByRole('combobox', { name: 'Conversation mode' }).click();
  await glyph.page.getByRole('option', { name: 'Plan', exact: true }).click();
  provider.enqueue(
    { output: [ScriptedProvider.tool('save_plan', plan, { namespace: 'planning', callId: 'plan' })] },
    { chunks: ['The plan is ready for review.'] },
  );
  await glyph.send('Plan a queue for messages.');
  await expect(glyph.page.getByRole('article', { name: 'Plan: Queue messages' })).toBeVisible();
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
}
/**
 * @param {GlyphWorkbench} glyph
 * @param {import('@playwright/test').Locator} source
 * @param {string} comment
 */
async function annotate(glyph, source, comment) {
  await source.dblclick({ position: { x: 10, y: 10 } });
  await expect(glyph.page.getByRole('button', { name: 'Comment on selection', exact: true })).toBeVisible();
  const anchor = await glyph.page.evaluate(() => {
    const rect = document.getSelection().getRangeAt(0).getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top };
  });
  const button = glyph.page.getByRole('button', { name: 'Comment on selection', exact: true });
  await expect(button).toHaveText('Add to Chat');
  const pill = await button.boundingBox();
  // The text pill sits above the selection; the numbered marker remains attached to its end.
  expect(pill.y + pill.height).toBeLessThanOrEqual(anchor.top);
  expect(anchor.top - pill.y - pill.height).toBeLessThan(12);
  expect(Math.abs(pill.x + pill.width / 2 - (anchor.left + anchor.right) / 2)).toBeLessThan(1);
  await glyph.page.getByRole('button', { name: 'Comment on selection', exact: true }).click();
  await glyph.page.getByRole('textbox', { name: 'Annotation comment' }).fill(comment);
  await glyph.page.getByRole('textbox', { name: 'Annotation comment' }).press('Enter');
  await expect(glyph.page.getByRole('form', { name: 'Annotation editor' })).not.toBeVisible();
}
/** @param {ScriptedProvider['requests'][number] | undefined} request */
function sentAnnotations(request) {
  if (!request) throw new Error('No provider request');
  const text = request.body.input
    .flatMap(item => (Array.isArray(item.content) ? item.content.map(part => part.text ?? '') : [item.content ?? '']))
    .findLast(value => value.includes('User annotations'));
  if (!text) throw new Error('No annotations in provider request');
  return z
    .array(z.looseObject({ id: z.string(), order: z.number(), quote: z.string() }))
    .parse(parseJson(text.slice(text.indexOf('\n[', text.indexOf('User annotations')) + 1)));
}
it.describe('Plans and passage annotations', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });
  it('previews the cited passage and comment from an agent annotation citation and reveals the passage on click', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Exact passage for feedback.'] });
    await glyph.send('Show a passage.');
    const transcript = glyph.page.locator('.glyph-transcript');
    const source = transcript.locator('[data-glyph-source]').filter({ hasText: 'Exact passage for feedback.' });
    await expect(source).toBeVisible();
    await annotate(glyph, source, 'Please clarify');
    provider.enqueue({ chunks: ['Noted.'] });
    await glyph.send('Use my feedback.');
    await expect(transcript).toContainText('Noted.');
    const [annotation] = sentAnnotations(provider.requests.at(-1));
    const filler = Array.from({ length: 60 }, (_, index) => `Detail ${index + 1}.`).join('\n\n');
    provider.enqueue({
      chunks: [`${filler}\n\nSee [Annotation ${annotation.order}](glyph-annotation:${annotation.id}).`],
    });
    await glyph.send('Cite my annotation.');
    const citation = transcript.getByRole('link', { name: `Annotation ${annotation.order}`, exact: true });
    await expect(citation).toBeVisible();
    await expect(citation).toHaveText(`Annotation ${annotation.order}`);
    await expect(source).not.toBeInViewport();
    const preview = glyph.page.getByRole('tooltip');
    await citation.hover();
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Selected text:');
    await expect(preview).toContainText(annotation.quote);
    await expect(preview).toContainText('User comment:');
    await expect(preview).toContainText('Please clarify');
    await glyph.page.mouse.move(0, 0);
    await expect(preview).toBeHidden();
    await citation.focus();
    await expect(preview).toContainText('Please clarify');
    await citation.press('Escape');
    await expect(preview).toBeHidden();
    await citation.click();
    await expect(source).toBeInViewport();
    const highlight = glyph.page.locator('.glyph-annotation-reveal');
    await expect(highlight.first()).toBeVisible();
    await expect(highlight).toHaveCount(0);
  });
  it(
    'blocks execution while planning and renders a saved native plan with editable todos and linked chats',
    reloadsWindow,
    async ({ glyph, provider }) => {
      await glyph.page.getByRole('combobox', { name: 'Conversation mode' }).click();
      await glyph.page.getByRole('option', { name: 'Plan', exact: true }).click();
      provider.enqueue(
        {
          output: [
            ScriptedProvider.tool(
              'execute_shell',
              {
                command: 'touch must-not-exist',
                terminal_id: null,
                working_directory: null,
                background: false,
                wake_on: null,
                timeout_ms: 5000,
              },
              { namespace: 'shell', callId: 'blocked' },
            ),
            ScriptedProvider.tool(
              'read_project_file',
              { path: 'example.txt', start_line: null, end_line: null },
              { callId: 'read' },
            ),
            ScriptedProvider.tool(
              'propose_question',
              {
                title: 'Questions',
                questions: [
                  {
                    id: 'order',
                    prompt: 'Preserve ordering?',
                    allow_multiple: false,
                    options: [
                      { id: 'yes', label: 'Yes' },
                      { id: 'no', label: 'No' },
                    ],
                  },
                ],
              },
              { namespace: 'interaction', callId: 'question' },
            ),
          ],
        },
        { chunks: ['Execution requires Build.'] },
      );
      await glyph.send('Explore only.');
      const question = glyph.page.getByRole('form', { name: 'Questions' });
      await question.getByRole('radio', { name: 'Yes', exact: true }).click();
      await question.getByRole('button', { name: 'Continue' }).click();
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('Execution requires Build.');
      expect(JSON.stringify(provider.requests.at(-1).body.input)).toContain('TOOL_MODE_DENIED');
      const read = provider.requests
        .at(-1)
        ?.body.input.find(item => item.type === 'function_call_output' && item.call_id === 'read');
      expect(editToolOutput.parse(parseJson(read?.output)).revision).toBeTruthy();
      await expect(access(join(glyph.workspace, 'must-not-exist'))).rejects.toThrow();
      await createPlan(glyph, provider);
      await glyph.page.getByRole('button', { name: 'View Plan', exact: true }).click();
      const document = glyph.page.locator('.glyph-plan-document');
      await expect(document.getByRole('heading', { name: 'Queue messages', exact: true })).toBeVisible();
      await expect(document.getByRole('img', { name: 'Plan diagram' })).toBeVisible();
      await document.getByRole('button', { name: 'New todo' }).click();
      await document.getByRole('textbox', { name: 'Todo description' }).fill('Verify failed sends');
      await document.getByRole('textbox', { name: 'Todo description' }).press('Enter');
      await expect(document).toContainText('Verify failed sends');
      await expect(document.getByTitle('Queue messages · Revision 2', { exact: true })).toBeVisible();
      await document.getByRole('button', { name: 'New agent' }).click();
      await expect(document).toContainText('Reviewer');
      await expect(glyph.composer).toContainText('Review this plan');
      await expect(document).toContainText('Author');
      await document.getByRole('button').filter({ hasText: 'Author' }).click();
      await glyph.reload();
      await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toHaveText('Plan');
      await glyph.page.getByRole('button', { name: 'View Plan', exact: true }).click();
      await expect(glyph.page.locator('.glyph-plan-document')).toContainText('Verify failed sends');
      await expect(glyph.page.locator('.glyph-plan-document')).toContainText('Reviewer');
      await glyph.page.locator('.glyph-plan-document').getByRole('button').filter({ hasText: 'Reviewer' }).click();
      await glyph.reload();
      await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toHaveText('Plan');
      provider.enqueue({ chunks: ['Reviewing the linked plan.'] });
      await glyph.send('Review the linked plan.');
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('Reviewing the linked plan.');
      expect(JSON.stringify(provider.requests.at(-1).body.input)).toContain('plan_reference');
      expect(JSON.stringify(provider.requests.at(-1).body.input)).toContain('Verify failed sends');
    },
  );
  it(
    'builds a plan in a separate linked chat and preserves the source conversation',
    reloadsWindow,
    async ({ glyph, provider }) => {
      await createPlan(glyph, provider);
      const card = glyph.page.getByRole('article', { name: 'Plan: Queue messages' });
      await card.getByRole('button', { name: 'Build options', exact: true }).click();
      provider.enqueue({ chunks: ['Building in the linked chat.'] });
      await card.getByRole('button', { name: 'Build in new chat' }).click();
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('Building in the linked chat.');
      await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toHaveText('Agent');
      const input = JSON.stringify(provider.requests.at(-1).body.input);
      expect(input).toContain('Build this approved plan');
      expect(input).toContain('revision 1');
      expect(input).toContain('plan_reference');
      await glyph.reload();
      await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toHaveText('Agent');
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('Building in the linked chat.');
    },
  );
  it(
    'attaches exact quotes, edits and deletes annotations, and persists sent annotations across reload',
    reloadsWindow,
    async ({ glyph, provider }) => {
      provider.enqueue({ chunks: ['Exact passage for feedback.'] });
      await glyph.send('Show a passage.');
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('Exact passage for feedback.');
      await annotate(
        glyph,
        glyph.page
          .locator('.glyph-transcript')
          .locator('[data-glyph-source]')
          .filter({ hasText: 'Exact passage for feedback.' }),
        'Please clarify',
      );
      const pill = glyph.page.locator('.glyph-composer .glyph-annotation-pill');
      await expect(pill).toContainText('1 annotation');
      await pill.hover();
      await pill.getByRole('button', { name: 'Edit annotation 1' }).click();
      const editor = glyph.page.getByRole('textbox', { name: 'Annotation comment' });
      await expect(editor).toHaveValue('Please clarify');
      await editor.fill('Explain');
      await editor.press('Shift+Enter');
      await editor.pressSequentially('with examples');
      await editor.press('Enter');
      await pill.hover();
      await expect(pill).toContainText('with examples');
      await annotate(
        glyph,
        glyph.page.locator('.glyph-transcript [data-glyph-source]').filter({ hasText: 'Exact passage for feedback.' }),
        'Discard this comment',
      );
      await pill.hover();
      await pill.getByRole('button', { name: 'Delete annotation 2' }).click();
      await expect(pill).toContainText('1 annotation');
      provider.enqueue({ chunks: ['Feedback received.'] });
      await glyph.send('Use my feedback.');
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('Feedback received.');
      expect(JSON.stringify(provider.requests.at(-1).body.input)).toContain('with examples');
      await expect(glyph.page.locator('.glyph-transcript').locator('.glyph-annotation-pill')).toHaveCount(1);
      await glyph.reload();
      await expect(glyph.page.locator('.glyph-transcript').locator('.glyph-annotation-pill')).toHaveCount(1);
      await glyph.page.locator('.glyph-transcript').locator('.glyph-annotation-pill').hover();
      await expect(glyph.page.locator('.glyph-transcript')).toContainText('with examples');
    },
  );
  it('clears every draft annotation and marker with the pill X', async ({ glyph, provider }) => {
    provider.enqueue({ chunks: ['Two comments on this passage.'] });
    await glyph.send('Show a passage to annotate.');
    const source = glyph.page
      .locator('.glyph-transcript [data-glyph-source]')
      .filter({ hasText: 'Two comments on this passage.' });
    await expect(source).toBeVisible();
    await annotate(glyph, source, 'First comment');
    await annotate(glyph, source, 'Second comment');
    const pill = glyph.page.locator('.glyph-composer .glyph-annotation-pill');
    await expect(pill).toContainText('2 annotations');
    await expect(glyph.page.locator('.glyph-annotation-marker')).toHaveCount(2);
    await pill.hover();
    await pill.getByRole('button', { name: 'Remove all annotations' }).click();
    await expect(pill).toHaveCount(0);
    await expect(glyph.page.locator('.glyph-annotation-marker')).toHaveCount(0);
    await expect(source).toBeVisible();
  });
  it('annotates a plan before Build and sends the exact reviewed revision with its feedback in Agent mode', async ({
    glyph,
    provider,
  }) => {
    await createPlan(glyph, provider);
    await glyph.page.getByRole('button', { name: 'View Plan', exact: true }).click();
    const document = glyph.page.locator('.glyph-plan-document');
    await annotate(glyph, document.locator('[data-glyph-source] p').first(), 'Preserve whitespace too');
    await document.getByRole('heading', { name: 'Queue messages', exact: true }).click();
    await glyph.page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
    await expect(document).not.toBeVisible();
    const pill = glyph.page.locator('.glyph-composer .glyph-annotation-pill');
    await pill.hover();
    await pill.getByRole('button', { name: 'Edit annotation 1' }).click();
    await expect(document).toBeVisible();
    await expect(glyph.page.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue(
      'Preserve whitespace too',
    );
    await glyph.page.getByRole('textbox', { name: 'Annotation comment' }).press('Enter');
    await expect(glyph.page.locator('.glyph-annotation-marker')).toBeVisible();
    await expect(glyph.page.locator('.glyph-annotation-marker > svg')).not.toHaveCSS('fill', 'rgba(0, 0, 0, 0)');
    await glyph.page.screenshot({ path: '/tmp/glyph-rank11-plan.png' });
    provider.enqueue({ chunks: ['Building the approved revision.'] });
    await document.getByRole('button', { name: 'Build ⌘↵', exact: true }).click();
    await expect(glyph.page.locator('.glyph-transcript')).toContainText('Building the approved revision.');
    const input = JSON.stringify(provider.requests.at(-1).body.input);
    expect(input).toContain('Build this approved plan');
    expect(input).toContain('Preserve whitespace too');
    expect(input).toContain('revision 1');
    await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toHaveText('Agent');
  });
});
