import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';

const requireUpstream = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = requireUpstream('@playwright/test');
let browser;
let script;

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { mountGlyphWorkbench } from './code-oss/ui/mountGlyphWorkbench.tsx';
        import { workbenchState, previewActions } from './code-oss/storybook/fixtures.ts';
        const question = { id: 'question', title: 'Questions', prompt: 'Choose.', questions: [{ id: 'choice', prompt: 'Choose.', allowMultiple: false, options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] }] };
        const run = { chatId: 'chat', runId: 'run', text: '', reasoning: '', tools: [], status: 'waiting_for_question', question };
        let state = workbenchState({ selectedChatId: 'chat', status: 'waiting_for_question', runs: [run], transcript: [{ id: 'run', role: 'assistant', text: 'Waiting.' }] });
        window.requests = [];
        const operation = (...args) => { window.requests.push(args); return new Promise((resolve, reject) => { window.fail = () => reject(new Error('Connection interrupted. Try again.')); window.acknowledge = resolve; }); };
        const view = mountGlyphWorkbench(document.getElementById('root'), state, { ...previewActions, answerQuestion: operation, decideApproval: operation });
        window.update = patch => { state = { ...state, ...patch }; view.update(state); };
        window.showApproval = () => window.update({ status: 'waiting_for_approval', runs: [{ ...run, status: 'waiting_for_approval', question: undefined, approval: { id: 'approval', title: 'Allow shell command?', detail: 'pwd', command: 'pwd', workingDirectory: '/workspace', sandboxed: true, canRemember: true } }] });
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
async function pageForTest() {
  const page = await browser.newPage();
  await page.setContent('<div id="root" style="width:400px;height:700px"></div>');
  await page.addScriptTag({ content: script });
  return page;
}

it('guards duplicate answers and preserves a failed submission for retry until the host acknowledges it', async () => {
  const page = await pageForTest();
  try {
    const form = page.getByRole('form', { name: 'Questions' });
    await form.getByRole('radio', { name: 'Other…' }).check();
    await form.getByRole('textbox', { name: 'Your answer' }).fill('My answer');
    await form.evaluate(element => {
      element.requestSubmit();
      element.requestSubmit();
    });
    await expect(form.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    expect(await page.evaluate(() => window.requests)).toHaveLength(1);
    await page.evaluate(() => window.fail());
    await expect(form.getByRole('alert')).toContainText('Connection interrupted');
    await expect(form.getByRole('textbox', { name: 'Your answer' })).toHaveValue('My answer');
    await form.getByRole('button', { name: 'Continue' }).click();
    expect(await page.evaluate(() => window.requests)).toEqual(
      Array(2).fill([
        'chat',
        'run',
        'question',
        { answers: [{ questionId: 'choice', type: 'OTHER', text: 'My answer' }] },
      ]),
    );
    await page.evaluate(() => window.acknowledge());
    await expect(form.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    await page.evaluate(() => window.update({ runs: [], status: 'ready' }));
    await expect(form).toHaveCount(0);
  } finally {
    await page.close();
  }
});

it('retains question drafts across chat switches and disables answering in a read-only window', async () => {
  const page = await pageForTest();
  try {
    const form = page.getByRole('form', { name: 'Questions' });
    await form.getByRole('radio', { name: 'Other…' }).check();
    await form.getByRole('textbox', { name: 'Your answer' }).fill('Draft for this chat');
    await page.evaluate(() => window.update({ selectedChatId: 'other-chat' }));
    await expect(form).toHaveCount(0);
    await page.evaluate(() => window.update({ selectedChatId: 'chat', readOnly: true }));
    await expect(form.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Draft for this chat');
    await expect(form.getByRole('textbox', { name: 'Your answer' })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await form.evaluate(element => element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(await page.evaluate(() => window.requests)).toHaveLength(0);
    await page.evaluate(() => window.update({ readOnly: false }));
    await expect(form.getByRole('button', { name: 'Continue' })).toBeEnabled();
  } finally {
    await page.close();
  }
});

it('disables duplicate approval decisions, permits retry after failure, and respects read-only ownership', async () => {
  const page = await pageForTest();
  try {
    await page.evaluate(() => window.showApproval());
    const card = page.getByRole('region', { name: 'Command approval' });
    await page.evaluate(() => window.update({ readOnly: true }));
    for (const button of await card.getByRole('button').all()) await expect(button).toBeDisabled();
    await page.evaluate(() => window.update({ readOnly: false }));
    await card.getByRole('button', { name: 'Run', exact: true }).evaluate(element => {
      element.click();
      element.click();
    });
    expect(await page.evaluate(() => window.requests)).toEqual([['chat', 'run', 'approval', 'allow_once']]);
    for (const button of await card.getByRole('button').all()) await expect(button).toBeDisabled();
    await page.evaluate(() => window.fail());
    await expect(card.getByRole('alert')).toContainText('Connection interrupted');
    await card.getByRole('button', { name: 'Skip', exact: true }).click();
    expect(await page.evaluate(() => window.requests)).toEqual([
      ['chat', 'run', 'approval', 'allow_once'],
      ['chat', 'run', 'approval', 'deny'],
    ]);
  } finally {
    await page.close();
  }
});
