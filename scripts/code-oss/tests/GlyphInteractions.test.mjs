import { build } from 'esbuild';
import { afterAll, beforeAll, it } from 'vitest';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
import { chromium, expect } from '#scripts/code-oss/tests/support/playwright.mjs';

/** @type {import('@playwright/test').Browser} */
let browser;
/** @type {string} */
let script;

beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { mountGlyphWorkbench } from './code-oss/ui/mountGlyphWorkbench.tsx';
        import { workbenchStateFixture } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
        import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
        const question = { id: 'question', title: 'Questions', prompt: 'Choose.', questions: [{ id: 'choice', prompt: 'Choose.', allowMultiple: false, options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] }] };
        const run = { chatId: 'chat', runId: 'run', text: '', reasoning: '', tools: [], status: 'waiting_for_question', question };
        let state = workbenchStateFixture({ selectedChatId: 'chat', status: 'waiting_for_question', runs: [run], transcript: [{ id: 'run', role: 'assistant', text: 'Waiting.' }] });
        window.requests = [];
        const operation = (...args) => { window.requests.push(args); return new Promise((resolve, reject) => { window.fail = () => reject(new Error('Connection interrupted. Try again.')); window.acknowledge = resolve; }); };
        const view = mountGlyphWorkbench(document.getElementById('root'), state, {
          ...previewActionsFixture(), answerQuestion: operation, decideApproval: operation,
          selectAccount: async (...args) => { window.requests.push(['account', ...args]); },
          selectModel: async (...args) => { window.requests.push(['model', ...args]); },
          openChat: async (...args) => { window.requests.push(['open', ...args]); },
          newChat: () => { window.requests.push(['new']); },
        });
        window.update = patch => { state = { ...state, ...patch }; view.update(state); };
        window.showApproval = () => window.update({ status: 'waiting_for_approval', runs: [{ ...run, status: 'waiting_for_approval', question: undefined, approval: { id: 'approval', title: 'Allow shell command?', detail: 'pwd', command: 'pwd', workingDirectory: '/workspace', sandboxed: true, canRemember: true } }] });
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    ...coverageBuildOptions,
    // The IIFE harness supplies the module URL that the production ESM build provides.
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.url': '"https://glyph.test/ui/mountGlyphWorkbench.js"',
    },
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
async function pageForTest() {
  const page = await newCoveredPage(browser);
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
      if (!(element instanceof HTMLFormElement)) throw new TypeError('Expected a form.');
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
      Array.from({ length: 2 }, () => [
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
      if (!(element instanceof HTMLElement)) throw new TypeError('Expected a button.');
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

it('preserves multi-question selections and free text when navigating backward before submission', async () => {
  const page = await pageForTest();
  try {
    await page.evaluate(() =>
      window.update({
        runs: [
          {
            chatId: 'chat',
            runId: 'multi-run',
            status: 'waiting_for_question',
            question: {
              id: 'multi',
              title: 'Questions',
              prompt: 'Choose.',
              questions: [
                {
                  id: 'choices',
                  prompt: 'Pick features',
                  allowMultiple: true,
                  options: [
                    { id: 'a', label: 'First' },
                    { id: 'b', label: 'Second' },
                  ],
                },
                { id: 'details', prompt: 'Add details', allowMultiple: false, options: [] },
              ],
            },
          },
        ],
      }),
    );
    const form = page.getByRole('form', { name: 'Questions' });
    const next = form.getByRole('button', { name: 'Continue' });
    await expect(next).toBeDisabled();
    await expect(form.getByRole('group')).toHaveCount(2);
    const viewport = form.locator('.glyph-question-scroll');
    expect(await viewport.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const footerTop = (await next.boundingBox()).y;
    await viewport.hover();
    await page.mouse.wheel(0, 600);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(form.locator('header')).toContainText('2 of 2');
    expect((await next.boundingBox()).y).toBe(footerTop);
    await form.getByRole('textbox', { name: 'Your answer' }).fill('Initial details');
    // The first unanswered question must be visited, not submitted.
    await next.click();
    await expect(form.locator('header')).toContainText('1 of 2');
    expect(await page.evaluate(() => window.requests)).toHaveLength(0);
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
    // Navigation does not require an answer.
    await form.getByRole('button', { name: 'Next question' }).click();
    await expect(form.locator('header')).toContainText('2 of 2');
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await form.getByRole('button', { name: 'Previous question' }).click();
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
    await form.getByRole('checkbox', { name: 'First' }).check();
    await form.getByRole('checkbox', { name: 'Second' }).check();
    await next.click();
    const other = form.getByRole('textbox', { name: 'Your answer' });
    await expect(other).toBeFocused();
    await other.fill('Keep these details');
    await form.getByRole('button', { name: 'Back' }).click();
    await expect(form.getByRole('checkbox', { name: 'First' })).toBeChecked();
    await form.getByRole('checkbox', { name: 'Second' }).uncheck();
    await next.click();
    await expect(other).toHaveValue('Keep these details');
    await next.click();
    expect(await page.evaluate(() => window.requests)).toEqual([
      [
        'chat',
        'multi-run',
        'multi',
        {
          answers: [
            { questionId: 'choices', type: 'SELECTION', optionIds: ['a'] },
            { questionId: 'details', type: 'OTHER', text: 'Keep these details' },
          ],
        },
      ],
    ]);
  } finally {
    await page.close();
  }
});

it('wires account and model choices and keeps filtered history open until explicitly closed', async () => {
  const page = await pageForTest();
  try {
    await page.evaluate(() =>
      window.update({
        selectedChatId: undefined,
        status: 'ready',
        runs: [],
        accounts: [
          { provider: 'provider', id: 'a', label: 'Account A', connected: true, inferenceAccess: true },
          { provider: 'provider', id: 'b', label: 'Account B', connected: true, inferenceAccess: true },
        ],
        selectedAccount: { provider: 'provider', id: 'a' },
        selectedModel: 'first',
        models: [
          { slug: 'first', name: 'First model' },
          { slug: 'second', name: 'Second model' },
        ],
        chats: [
          {
            id: 'saved',
            title: 'Saved conversation',
            accountProvider: 'provider',
            accountId: 'a',
            modelSlug: 'first',
            updatedAt: new Date().toISOString(),
            turnCount: 1,
          },
          {
            id: 'older',
            title: 'Older conversation',
            accountProvider: 'provider',
            accountId: 'b',
            modelSlug: 'second',
            updatedAt: '2020-01-01T00:00:00Z',
            turnCount: 1,
          },
        ],
      }),
    );
    await page.getByRole('combobox', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: 'Second model', exact: true }).click();
    const toggle = page.getByRole('button', { name: 'Chat history', exact: true });
    await toggle.click();
    const account = page.getByRole('combobox', { name: 'Account', exact: true });
    await account.selectOption(JSON.stringify(['provider', 'b']));
    const search = page.getByRole('searchbox', { name: 'Search chats' });
    await search.fill('saved');
    await expect(page.getByRole('button', { name: 'Older conversation' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Saved conversation', exact: true }).click();
    await page.evaluate(() => window.update({ selectedChatId: 'saved' }));
    await expect(search).toBeVisible();
    await expect(page.getByRole('button', { name: 'Saved conversation', exact: true })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await toggle.click();
    await expect(search).toHaveCount(0);
    await expect(toggle).toBeFocused();
    expect(await page.evaluate(() => window.requests)).toEqual([
      ['model', 'second'],
      ['account', 'provider', 'b'],
      ['open', 'saved'],
    ]);
    await page.evaluate(() => window.update({ selectedChatId: 'saved' }));
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
    await toggle.click();
    await expect(account).toBeDisabled();
    await expect(account).toHaveValue(JSON.stringify(['provider', 'a']));
  } finally {
    await page.close();
  }
});

it('shows whether each saved chat is working, awaiting input, completed, ended early, or empty', async () => {
  const page = await pageForTest();
  try {
    await page.evaluate(() => {
      const updatedAt = new Date().toISOString();
      const chat = (id, turnCount = 1) => ({
        id,
        title: `${id} chat`,
        accountProvider: 'provider',
        accountId: 'a',
        modelSlug: 'first',
        updatedAt,
        turnCount,
      });
      const run = (chatId, runId, status) => ({ chatId, runId, status, text: '', reasoning: '', tools: [] });
      window.update({
        selectedChatId: undefined,
        status: 'ready',
        chats: [
          chat('working'),
          chat('question'),
          chat('approval'),
          chat('completed'),
          chat('cancelled'),
          chat('interrupted'),
          chat('failed'),
          chat('unopened'),
          chat('empty', 0),
        ],
        runs: [
          run('working', 'earlier', 'completed'),
          run('working', 'current', 'streaming'),
          run('question', 'current', 'waiting_for_question'),
          run('approval', 'current', 'waiting_for_approval'),
          run('completed', 'current', 'completed'),
          run('cancelled', 'current', 'cancelled'),
          run('interrupted', 'current', 'interrupted'),
          run('failed', 'earlier', 'completed'),
          run('failed', 'current', 'failed'),
        ],
      });
    });
    await page.getByRole('button', { name: 'Chat history', exact: true }).click();
    const status = (id, name) =>
      page.getByRole('button', { name: `${id} chat`, exact: true }).getByRole('img', { name, exact: true });
    await expect(status('working', 'Working')).toBeVisible();
    await expect(status('question', 'Awaiting input')).toBeVisible();
    await expect(status('approval', 'Awaiting input')).toBeVisible();
    await expect(status('completed', 'Completed')).toBeVisible();
    await expect(status('cancelled', 'Cancelled')).toBeVisible();
    await expect(status('interrupted', 'Interrupted')).toBeVisible();
    await expect(status('failed', 'Failed')).toBeVisible();
    await expect(status('unopened', 'Completed')).toBeVisible();
    await expect(status('empty', 'No messages yet')).toBeVisible();
    await page.evaluate(
      () =>
        (document.querySelector(/** @type {'div'} */ ('#root')).style.cssText +=
          '; --vscode-editorError-foreground: rgb(241, 76, 76)'),
    );
    for (const [id, name] of [
      ['cancelled', 'Cancelled'],
      ['interrupted', 'Interrupted'],
      ['failed', 'Failed'],
    ])
      await expect(status(id, name)).toHaveCSS('color', 'rgb(241, 76, 76)');
    const pulse = status('working', 'Working').locator('span');
    await expect(pulse).toHaveCSS('animation-iteration-count', 'infinite');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(pulse).toHaveCSS('animation-name', 'none');
    await page.evaluate(() =>
      window.update({
        runs: [{ chatId: 'working', runId: 'current', status: 'completed', text: '', reasoning: '', tools: [] }],
      }),
    );
    await expect(status('working', 'Completed')).toBeVisible();
  } finally {
    await page.close();
  }
});

it('lists an unsent new chat as a draft at the top of the day it was started and reopens it', async () => {
  const page = await pageForTest();
  try {
    await page.evaluate(() => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(12, 0, 0, 0);
      const chat = (id, updatedAt) => ({
        id,
        title: `${id} chat`,
        accountProvider: 'provider',
        accountId: 'a',
        modelSlug: 'first',
        updatedAt,
        turnCount: 1,
      });
      window.update({
        selectedChatId: 'today',
        status: 'ready',
        runs: [],
        chats: [
          chat('today', new Date().toISOString()),
          chat('yesterday', new Date(yesterday.getTime() + 60_000).toISOString()),
        ],
        newChatDraft: {
          text: '\n  Get me a screenshot of the sidebar\nwith every status',
          createdAt: yesterday.toISOString(),
        },
      });
    });
    await page.getByRole('button', { name: 'Chat history', exact: true }).click();
    const yesterdayGroup = page.getByRole('region', { name: 'Yesterday', exact: true });
    const rows = yesterdayGroup.getByRole('button', { name: /chat|Draft/u });
    await expect(rows).toHaveText(
      ['Get me a screenshot of the sidebar', 'yesterday chat'].map(text => new RegExp(text, 'u')),
    );
    const draft = yesterdayGroup.getByRole('button', {
      name: 'Draft: Get me a screenshot of the sidebar',
      exact: true,
    });
    await expect(draft.getByRole('img', { name: 'Draft', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Today', exact: true })).not.toContainText('Draft');
    await draft.hover();
    await expect(page.getByRole('button', { name: /^(Pin|Archive) Draft/u })).toHaveCount(0);
    await draft.click();
    expect(await page.evaluate(() => window.requests)).toEqual([['new']]);
    await page.evaluate(() => window.update({ selectedChatId: undefined }));
    await expect(draft).toHaveAttribute('aria-current', 'true');
    await page.getByRole('searchbox', { name: 'Search chats' }).fill('today');
    await expect(draft).toHaveCount(0);
  } finally {
    await page.close();
  }
});

it('spins the model retry arrows while loading and permits another attempt after failure', async () => {
  const page = await pageForTest();
  try {
    await page.evaluate(() =>
      window.update({
        selectedChatId: undefined,
        status: 'ready',
        runs: [],
        accounts: [{ provider: 'provider', id: 'a', label: 'Account A', connected: true, inferenceAccess: true }],
        selectedAccount: { provider: 'provider', id: 'a' },
        selectedModel: undefined,
        models: [],
        navigationError: 'Catalog unavailable',
        catalogPending: false,
      }),
    );
    await page.getByRole('button', { name: 'Chat history', exact: true }).click();
    const retry = page.getByRole('button', { name: 'Models unavailable', exact: true });
    const arrows = await retry.locator('svg').innerHTML();
    await retry.click();
    expect(await page.evaluate(() => window.requests)).toEqual([['account', 'provider', 'a']]);
    await page.evaluate(() => window.update({ catalogPending: true, navigationError: undefined }));
    const loading = page.getByRole('button', { name: 'Loading models…', exact: true });
    await expect(loading).toBeDisabled();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(await loading.locator('svg').innerHTML()).toBe(arrows);
    const spinner = loading.locator('svg').locator('..');
    await expect(spinner).toHaveCSS('animation-iteration-count', 'infinite');
    await expect(spinner).toHaveCSS('animation-duration', '0.9s');
    await loading.evaluate(element => {
      if (!(element instanceof HTMLElement)) throw new TypeError('Expected a button.');
      element.click();
    });
    expect(await page.evaluate(() => window.requests)).toHaveLength(1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page.evaluate(() => window.update({ catalogPending: false, navigationError: 'Still unavailable' }));
    await expect(retry).toBeEnabled();
    await retry.click();
    expect(await page.evaluate(() => window.requests)).toHaveLength(2);
    await page.evaluate(() => window.update({ readOnly: true }));
    await expect(retry).toBeDisabled();
    await page.evaluate(() => window.update({ readOnly: false, navigationError: undefined, selectedModel: 'ready' }));
    await expect(retry).toHaveCount(0);
    await expect(page.locator('.glyph-account-picker')).toContainText('Connected account');
  } finally {
    await page.close();
  }
});
