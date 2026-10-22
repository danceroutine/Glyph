import { build } from 'esbuild';
import { afterAll, beforeAll, describe, it } from 'vitest';
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
        import { h, render } from 'preact';
        import { WiredGlyphComposer } from './code-oss/ui/GlyphComposer/GlyphComposer.wired.tsx';
        import { GlyphComposerState } from './src/desktop/workbench/GlyphComposerState.ts';
        const calls = [];
        const steering = [];
        const menuActions = [];
        const pending = [];
        const captures = [];
        let selectFiles;
        const attachment = { id: 'a', kind: 'file', uri: 'file:///a.ts', path: 'a.ts', text: 'Exact captured source', contentRevision: 'hash', token: { workspaceGeneration: 'w', resource: 'file:///a.ts', incarnation: 'i', version: 1 } };
        let contextCandidates = [{ uri: attachment.uri, path: attachment.path }];
        const actions = {
          composer: new GlyphComposerState(),
          context: { selectFiles: () => new Promise(resolve => { selectFiles = resolve; }), searchFiles: async query => contextCandidates.filter(file => file.path.includes(query)), captureFile: async uri => ({ ...attachment, ...contextCandidates.find(file => file.uri === uri) }), captureFolder: async uri => ({ ...attachment, ...contextCandidates.find(file => file.uri === uri), kind: 'folder', text: 'Directory tree: src\\n  index.ts' }), openAttachment: async () => {}, checkAttachment: async () => undefined, refreshAttachment: async value => ({ ...value, text: 'Updated capture' }) },
          send(text, attachments) { captures.push(attachments); calls.push(text); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
          steer: async text => { steering.push(text); },
          sendImmediately: async text => { menuActions.push(text); },
          openMessageSettings: () => { menuActions.push('settings'); },
          moveQueuedToNewChat: async id => { menuActions.push('new-chat'); actions.composer.removeQueued(id); },
          cancel() {}
        };
        window.composerTest = {
          calls, captures, steering, menuActions,
          setContextCandidates(files) { contextCandidates = files; },
          snapshot: () => actions.composer.snapshot,
          selectFiles(cancel = false) { selectFiles(cancel ? [] : [attachment, { ...attachment, id: 'b', uri: 'file:///b.ts', path: 'b.ts' }]); },
          attachSelection() { actions.composer.insertAttachments([{ ...attachment, id: 'selection', kind: 'selection', path: 'b.ts', text: 'Only selected text', range: { start: { line: 3, column: 1 }, end: { line: 4, column: 5 } } }]); },
          unmount() { render(null, document.getElementById('root')); },
          mount(status = 'ready') { render(h(WiredGlyphComposer, { status, selection: undefined, actions }), document.getElementById('root')); },
          reject() { pending.shift().reject(new Error('Connection unavailable')); },
          resolve() { pending.shift().resolve(); }
        };
        render(h(WiredGlyphComposer, { status: 'ready', selection: undefined, actions }), document.getElementById('root'));
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    ...coverageBuildOptions,
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
  });
  script = result.outputFiles[0].text;
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe('WiredGlyphComposer draft recovery', () => {
  it.each(['before', 'after'])(
    'retains the draft and recovered message when send fails %s pane disposal',
    async when => {
      const page = await newCoveredPage(browser);
      try {
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ content: script });
        const composer = page.getByRole('textbox', { name: 'Message Glyph' });
        await composer.fill('Original message');
        await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
        await composer.fill('Newer draft');
        if (when === 'before') await page.evaluate(() => window.composerTest.reject());
        await page.evaluate(() => window.composerTest.unmount());
        if (when === 'after') await page.evaluate(() => window.composerTest.reject());
        await page.evaluate(() => window.composerTest.mount());
        await expect(composer).toHaveText('Newer draft', { timeout: 10_000 });
        await expect(page.getByRole('region', { name: 'Unsent messages' })).toContainText('Original message');
      } finally {
        await page.close();
      }
    },
  );
  it('retains a failed message separately from a newer draft and lets the user edit either without losing the other', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      const send = page.getByRole('button', { name: 'Send (Enter)', exact: true });
      await composer.fill('Original unsent message');
      await send.click();
      await expect(composer).toHaveText('');
      await composer.fill('Newer draft');
      await page.evaluate(() => window.composerTest.reject());
      await expect(page.getByRole('alert')).toContainText('Connection unavailable');
      await expect(composer).toHaveText('Newer draft');
      const unsent = page.getByRole('region', { name: 'Unsent messages' });
      await expect(unsent).toContainText('Original unsent message', { timeout: 1_000 });
      await unsent.getByRole('button', { name: 'Edit unsent message' }).click();
      await expect(composer).toHaveText('Original unsent message');
      await expect(unsent).toContainText('Newer draft');
      await send.click();
      await page.evaluate(() => window.composerTest.resolve());
      await expect(unsent).toContainText('Newer draft');
      expect(await page.evaluate(() => window.composerTest.calls)).toEqual([
        'Original unsent message',
        'Original unsent message',
      ]);
    } finally {
      await page.close();
    }
  });

  it('restores a rejected message directly when no newer draft was typed', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.fill('Keep this message');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await page.evaluate(() => window.composerTest.reject());
      await expect(composer).toHaveText('Keep this message');
    } finally {
      await page.close();
    }
  });

  it('preserves every rejected message through successive failures without sending a newer draft implicitly', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      const send = page.getByRole('button', { name: 'Send (Enter)', exact: true });
      await composer.fill('First message');
      await send.click();
      await composer.fill('Second message');
      await page.evaluate(() => window.composerTest.reject());
      const unsent = page.getByRole('region', { name: 'Unsent messages' });
      await expect(unsent).toContainText('First message');
      await send.click();
      await composer.fill('Third draft');
      await page.evaluate(() => window.composerTest.reject());
      await expect(unsent).toContainText('Second message');
      await expect(unsent).toContainText('First message');
      await expect(composer).toHaveText('Third draft');
      expect(await page.evaluate(() => window.composerTest.calls)).toEqual(['First message', 'Second message']);
    } finally {
      await page.close();
    }
  });
});

describe('Composer mode menu', () => {
  it('shows mode icons and selection, supports keyboard choice, and dismisses without changing mode', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root" style="padding-top:200px"></div>');
      await page.addScriptTag({ content: script });
      const mode = page.getByRole('combobox', { name: 'Conversation mode' });
      await expect(mode.locator('.glyph-agent-icon')).toHaveCSS('width', '14px');
      await expect(mode.locator('.glyph-agent-icon svg')).toHaveCount(2);
      await mode.click();
      await expect(mode).toBeFocused();
      await expect(page.getByRole('option', { name: 'Agent', exact: true })).toHaveAttribute('aria-selected', 'true');
      await mode.press('ArrowDown');
      await mode.press('Enter');
      await expect(mode).toHaveText('Plan');
      await expect(page.getByRole('listbox', { name: 'Conversation modes' })).toHaveCount(0);
      await mode.press('ArrowUp');
      await mode.press('Home');
      await mode.press('Escape');
      await expect(mode).toHaveText('Plan');
      await mode.click();
      await page.getByRole('option', { name: 'Agent', exact: true }).click();
      await expect(mode).toHaveText('Agent');
      await mode.click();
      await page.getByRole('textbox', { name: 'Message Glyph' }).click();
      await expect(mode).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await page.close();
    }
  });
});

describe('Inline attachment editing', () => {
  it('inserts files from the system picker at the saved caret and leaves cancellation unchanged', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      const attach = page.getByRole('button', { name: 'Attach file', exact: true });
      await composer.fill('before  after');
      // fill mutates the contenteditable DOM; wait for the editor to observe it
      // before sending native selection changes against that document.
      await expect.poll(() => page.evaluate(() => window.composerTest.snapshot().document.from)).toBe(13);
      for (let index = 0; index < 6; index++) {
        await composer.press('ArrowLeft');
        await expect.poll(() => page.evaluate(() => window.composerTest.snapshot().document.from)).toBe(12 - index);
      }
      await expect
        .poll(() => page.evaluate(() => window.composerTest.snapshot().document.from), { timeout: 10_000 })
        .toBe(7);
      await attach.click();
      await expect(attach).toBeDisabled();
      await expect(page.getByRole('listbox', { name: 'Files and folders to attach' })).toHaveCount(0);
      await page.evaluate(() => window.composerTest.selectFiles(true));
      await expect(attach).toBeEnabled();
      await expect(composer).toHaveText('before  after');
      await attach.click();
      await page.evaluate(() => window.composerTest.selectFiles());
      await expect(composer).toHaveText('before a.tsb.ts after');
      await composer.pressSequentially(' more');
      await expect(composer).toHaveText('before a.tsb.ts more after');
    } finally {
      await page.close();
    }
  });

  it('inserts file and native-selection badges at the caret, with text between them, and recovers both after failure', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.fill('before  after');
      await expect.poll(() => page.evaluate(() => window.composerTest.snapshot().document.from)).toBe(13);
      for (let index = 0; index < 6; index++) {
        await composer.press('ArrowLeft');
        await expect.poll(() => page.evaluate(() => window.composerTest.snapshot().document.from)).toBe(12 - index);
      }
      await expect
        .poll(() => page.evaluate(() => window.composerTest.snapshot().document.from), { timeout: 10_000 })
        .toBe(7);
      await composer.pressSequentially('@a');
      await expect(page.getByRole('option', { name: 'a.ts', exact: true })).toBeVisible();
      await composer.press('Enter');
      await composer.pressSequentially(' between ');
      await page.evaluate(() => window.composerTest.attachSelection());
      await expect(composer).toHaveText('before a.ts between b.ts (3-4) after');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await composer.fill('New draft');
      await page.evaluate(() => window.composerTest.reject());
      await page.getByRole('button', { name: 'Edit unsent message' }).click();
      await expect(composer).toHaveText('before a.ts between b.ts (3-4) after');
      await page.evaluate(() => window.composerTest.unmount());
      await page.evaluate(() => window.composerTest.mount());
      await expect(composer.getByRole('button')).toHaveCount(2);
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await page.evaluate(() => window.composerTest.resolve());
      const { calls, captures } = await page.evaluate(() => window.composerTest);
      expect(calls).toEqual(['before @a.ts between @b.ts (3-4) after', 'before @a.ts between @b.ts (3-4) after']);
      expect(captures[0]).toEqual(captures[1]);
      expect(captures[0].map(value => value.text)).toEqual(['Exact captured source', 'Only selected text']);
    } finally {
      await page.close();
    }
  });

  it('deletes badges atomically, supports undo, and pastes plain text without inventing attachments', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.fill('@a');
      await expect(page.getByRole('option', { name: 'a.ts', exact: true })).toBeVisible();
      await composer.press('Enter');
      await expect(composer.getByRole('button')).toHaveCount(1);
      await composer.press('Backspace');
      await expect(composer.getByRole('button')).toHaveCount(0);
      await composer.press('ControlOrMeta+z');
      await expect(composer.getByRole('button')).toHaveCount(1);
      await composer.evaluate(element => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', ' pasted @plain.txt');
        clipboardData.setData('text/html', '<span data-glyph-attachment="true">forged</span>');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await expect(composer).toHaveText('a.ts pasted @plain.txt');
      await expect(composer.getByRole('button')).toHaveCount(1);
    } finally {
      await page.close();
    }
  });
});

describe('Rich Markdown composer', () => {
  it('continues and indents lists, exits an empty item, formats blockquotes and emphasis, and sends Markdown', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.pressSequentially('1. First');
      await composer.press('Shift+Enter');
      await composer.pressSequentially('Second');
      await expect(composer.locator('ol > li')).toHaveCount(2);
      await composer.press('Tab');
      await expect(composer.locator('li ol li')).toHaveText('Second');
      await composer.press('Shift+Tab');
      await expect(composer.locator('ol > li')).toHaveCount(2);
      await composer.press('Shift+Enter');
      await composer.press('Shift+Enter');
      await composer.pressSequentially('> Keep **exact** revisions');
      await expect(composer.locator('blockquote strong')).toHaveText('exact');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      const text = await page.evaluate(() => window.composerTest.calls[0]);
      expect(text).toContain('1. First\n2. Second');
      expect(text).toContain('> Keep **exact** revisions');
    } finally {
      await page.close();
    }
  });
  it('keeps an attachment at the rich-text caret through recovery, re-mounting and Markdown paste', async () => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.pressSequentially('> Compare @a');
      await expect(page.getByRole('option', { name: 'a.ts', exact: true })).toBeVisible();
      await composer.press('Enter');
      await composer.pressSequentially(' **carefully**');
      await page.evaluate(() => window.composerTest.unmount());
      await page.evaluate(() => window.composerTest.mount());
      await expect(composer.locator('blockquote button')).toHaveCount(1);
      await expect(composer.locator('strong')).toHaveText('carefully');
      await composer.locator('strong').evaluate(element => {
        const editable = element.closest('[contenteditable]');
        if (!(editable instanceof HTMLElement)) throw new TypeError('The composer must be editable.');
        editable.focus();
        const text = element.firstChild;
        document.getSelection().collapse(text, text.textContent.length - 1);
        document.dispatchEvent(new Event('selectionchange'));
      });
      await expect.poll(() => page.evaluate(() => window.composerTest.snapshot().document.from)).toBe(22);
      await page.evaluate(() => window.composerTest.attachSelection());
      await expect(composer.locator('strong button')).toHaveCount(1);
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await page.evaluate(() => window.composerTest.reject());
      await expect(composer.locator('blockquote button')).toHaveCount(2);
      await expect(composer.locator('strong')).toContainText('carefullb.ts (3-4)y');
      await composer.press('ControlOrMeta+a');
      await composer.evaluate(element => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', '## Heading\n\n1. One\n2. Two\n\n> A quote');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      await expect(composer.locator('h2')).toHaveText('Heading');
      await expect(composer.locator('ol li')).toHaveCount(2);
      await expect(composer.locator('blockquote')).toHaveText('A quote');
    } finally {
      await page.close();
    }
  });
});

it('formats typed links and fenced code while preserving literal code and Markdown on submission', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('[source](src/a.ts)');
    await expect(composer.locator('.glyph-prompt-link')).toHaveText('source');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('```ts');
    await composer.press('Shift+Enter');
    await composer.press('Tab');
    await composer.pressSequentially('**literal**');
    await expect(composer.locator('pre code')).toHaveText('  **literal**');
    await expect(composer.locator('pre strong')).toHaveCount(0);
    await page.evaluate(() => window.composerTest.unmount());
    await page.evaluate(() => window.composerTest.mount());
    await expect(composer.locator('pre code')).toHaveText('  **literal**');
    await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    expect(await page.evaluate(() => window.composerTest.calls[0])).toContain('```ts\n  **literal**\n```');
  } finally {
    await page.close();
  }
});

it('uses Enter to submit and Shift+Enter to edit a multiline prompt', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.fill('First line');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('Second line');
    await expect(composer.locator('p')).toHaveText(['First line', 'Second line']);
    expect(await page.evaluate(() => window.composerTest.calls)).toEqual([]);
    await composer.press('Enter');
    expect(await page.evaluate(() => window.composerTest.calls)).toEqual(['First line\n\nSecond line']);
    await expect(composer).toHaveText('');
  } finally {
    await page.close();
  }
});

it('routes the steering shortcut separately and leaves the active response running', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.composerTest.mount('streaming'));
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.fill('Keep going with this constraint');
    await composer.press('ControlOrMeta+Enter');
    await expect(composer).toHaveText('');
    expect(await page.evaluate(() => window.composerTest.steering)).toEqual(['Keep going with this constraint']);
    expect(await page.evaluate(() => window.composerTest.calls)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
});

it('shows a collapsible draggable queue with decorative bullets and the requested row menu', async () => {
  const page = await newCoveredPage(browser);
  page.setDefaultTimeout(3000);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.composerTest.mount('streaming'));
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    for (const text of ['First queued task', 'Second queued task']) {
      await composer.fill(text);
      await composer.press('Enter');
    }
    const tray = page.getByRole('region', { name: 'Queued messages', exact: true });
    await expect(tray.getByRole('checkbox')).toHaveCount(0);
    const rows = tray.getByRole('listitem');
    await expect(rows.first()).toHaveCSS('cursor', 'grab');
    await rows.nth(1).focus();
    await rows.nth(1).press('Alt+ArrowUp');
    await expect(rows.first()).toContainText('Second queued task');
    const toggle = tray.getByRole('button', { name: '2 Queued Messages', exact: true });
    await toggle.click();
    await expect(rows).toHaveCount(0);
    await toggle.click();
    await expect(rows).toHaveCount(2);
    await rows.first().hover();
    await rows.first().hover();
    await rows.first().getByRole('button', { name: 'Queued message actions', exact: true }).click();
    const bounds = await tray.getByRole('menu').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    await tray.getByRole('menuitem', { name: 'New Message Settings', exact: true }).click();
    expect(await page.evaluate(() => window.composerTest.menuActions)).toEqual(['settings']);
    await rows.first().hover();
    await rows.first().getByRole('button', { name: 'Queued message actions', exact: true }).click();
    await tray.getByRole('menuitem', { name: 'Steer', exact: true }).click();
    expect(await page.evaluate(() => window.composerTest.steering)).toEqual(['Second queued task']);
    await expect(rows).toHaveCount(1);
    await rows.first().hover();
    await rows.first().getByRole('button', { name: 'Queued message actions', exact: true }).click();
    await tray.getByRole('menuitem', { name: 'Move to New Chat', exact: true }).click();
    await expect(tray).toHaveCount(0);
    expect(await page.evaluate(() => window.composerTest.menuActions)).toEqual(['settings', 'new-chat']);
    expect(await page.evaluate(() => window.composerTest.calls)).toEqual([]);
  } finally {
    await page.close();
  }
}, 20000);

it('edits a queued message in the composer, preserves it on cancel, and clears the draft on deletion', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.composerTest.mount('streaming'));
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.fill('Original queued task');
    await composer.press('Enter');
    const tray = page.getByRole('region', { name: 'Queued messages', exact: true });
    const row = tray.getByRole('listitem');
    const edit = async () => {
      await row.hover();
      await row.getByRole('button', { name: 'Edit queued message', exact: true }).click();
      await expect(page.getByText('Editing queued message', { exact: true })).toBeVisible();
      await expect(row).toHaveAttribute('data-editing', 'true');
      await expect(row).toHaveAttribute('draggable', 'false');
      await expect(row.getByRole('button')).toHaveCount(1);
      await composer.hover();
      await expect(row.getByRole('button', { name: 'Remove queued message' })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Remove queued message' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    };
    await edit();
    await expect(composer).toHaveText('Original queued task');
    await composer.fill('Discard this edit');
    await page.getByRole('button', { name: 'Cancel queue edit' }).click();
    await expect(composer).toHaveText('');
    await expect(row).toContainText('Original queued task');
    await expect(row).not.toHaveAttribute('data-editing');

    await edit();
    await expect(composer).toHaveText('Original queued task');
    await composer.press('ControlOrMeta+a');
    await composer.press('Backspace');
    await expect(composer).toHaveText('');
    await expect(page.getByRole('button', { name: 'Save queued message' })).toBeDisabled();
    await composer.press('Enter');
    await expect(row).toContainText('Original queued task');
    await composer.fill('Updated queued task');
    await page.getByRole('button', { name: 'Save queued message' }).click();
    await expect(composer).toHaveText('');
    await expect(row).toContainText('Updated queued task');
    await expect(page.getByText('Editing queued message', { exact: true })).toHaveCount(0);

    await edit();
    await row.getByRole('button', { name: 'Remove queued message' }).click();
    await expect(tray).toHaveCount(0);
    await expect(composer).toHaveText('');
    await expect(page.getByText('Editing queued message', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.composerTest.calls)).toEqual([]);
    expect(await page.evaluate(() => window.composerTest.steering)).toEqual([]);
    expect(await page.evaluate(() => window.composerTest.snapshot().queuePaused)).toBe(false);
  } finally {
    await page.close();
  }
}, 15000);

it('highlights code while typing without changing the caret, undo history or submitted Markdown', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('```ts');
    await composer.press('Shift+Enter');
    await composer.pressSequentially("const foo: string = '😀';");
    await expect(composer.locator('.hljs-keyword')).toHaveText('const');
    await expect(composer.locator('.hljs-string')).toHaveText("'😀'");
    await composer.press('ArrowLeft');
    await composer.press('ArrowLeft');
    await composer.pressSequentially('x');
    await expect(composer.locator('.hljs-string')).toHaveText("'😀x'");
    await composer.press('ControlOrMeta+z');
    await composer.press('ControlOrMeta+Shift+z');
    await expect(composer.locator('pre code')).toHaveText("const foo: string = '😀x';");
    await composer.press('Enter');
    expect(await page.evaluate(() => window.composerTest.calls[0])).toBe("```ts\nconst foo: string = '😀x';\n```");
  } finally {
    await page.close();
  }
});

it.each(['empty', 'selected'])(
  'preserves source pasted into a code block with %s content through recovery and submission',
  async state => {
    const page = await newCoveredPage(browser);
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.pressSequentially('```js');
      await composer.press('Shift+Enter');
      if (state === 'selected') {
        await composer.pressSequentially('replace this');
        for (let index = 0; index < 'replace this'.length; index++) await composer.press('Shift+ArrowLeft');
        expect(await page.evaluate(() => window.getSelection().toString())).toBe('replace this');
        await page.evaluate(
          () =>
            new Promise(resolve => {
              requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
              });
            }),
        );
      }
      const source = 'const marker = "**keep**";\nconst second = `raw`;';
      await composer.evaluate((element, sourceText) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', sourceText);
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      }, source);
      expect(await composer.locator('pre code').textContent()).toBe(source);
      await page.evaluate(() => {
        window.composerTest.unmount();
        window.composerTest.mount();
      });
      expect(await composer.locator('pre code').textContent()).toBe(source);
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      expect(await page.evaluate(() => window.composerTest.calls[0])).toBe(`\`\`\`js\n${source}\n\`\`\``);
    } finally {
      await page.close();
    }
  },
);

it('highlights pasted and unlabelled fences while leaving unknown languages as literal text', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        'text/plain',
        '```\nconst answer = 42;\n```\n\n```unknown-language\n<script>literal</script>\n```',
      );
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    await expect(composer.locator('pre').first().locator('[class*=hljs-]').first()).toBeVisible();
    await expect(composer.locator('pre').nth(1)).toHaveText('<script>literal</script>');
    await expect(composer.locator('pre').nth(1).locator('span')).toHaveCount(0);
    await page.evaluate(() => {
      window.composerTest.unmount();
      window.composerTest.mount();
    });
    await expect(composer.locator('pre').first().locator('[class*=hljs-]').first()).toBeVisible();
  } finally {
    await page.close();
  }
});

it.each(['ArrowDown', 'ArrowRight'])('leaves a trailing code block with %s and types in a new paragraph', async key => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('```ts');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('const answer = 42;');
    await composer.press(key);
    await composer.pressSequentially('Explain this.');
    await expect(composer.locator('pre')).toHaveText('const answer = 42;');
    await expect(composer.locator('p')).toHaveText('Explain this.');
    await composer.press('Enter');
    expect(await page.evaluate(() => window.composerTest.calls[0])).toBe(
      '```ts\nconst answer = 42;\n```\n\nExplain this.',
    );
  } finally {
    await page.close();
  }
});

it.each(['ArrowDown', 'ArrowRight'])('reuses the paragraph following a code block when leaving with %s', async key => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '```ts\nconst answer = 42;\n```\n\nExisting text');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      const code = element.querySelector('pre code');
      const range = document.createRange();
      range.selectNodeContents(code);
      range.collapse(false);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await composer.press(key);
    await composer.pressSequentially('Before: ');
    await expect(composer.locator('p')).toHaveCount(1);
    await expect(composer.locator('p')).toHaveText('Before: Existing text');
    await expect(composer.locator('pre')).toHaveText('const answer = 42;');
  } finally {
    await page.close();
  }
});

it.each(['ArrowUp', 'ArrowLeft'])(
  'leaves the start of a code block with %s without adding duplicate paragraphs',
  async key => {
    const page = await newCoveredPage(browser);
    try {
      for (const preceding of ['', 'Existing text\n\n']) {
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ content: script });
        const composer = page.getByRole('textbox', { name: 'Message Glyph' });
        const source = preceding + '```ts\nconst answer = 42;\n```';
        await composer.evaluate((element, sourceText) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', sourceText);
          element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
        }, source);
        await composer.focus();
        // Wait for ProseMirror to observe the caret, including syntax-highlighted text.
        await expect
          .poll(
            () =>
              composer.locator('pre code').evaluate(code => {
                const range = document.createRange();
                range.selectNodeContents(code);
                range.collapse(true);
                window.getSelection().removeAllRanges();
                window.getSelection().addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
                return window.composerTest.snapshot().document.from;
              }),
            { timeout: 10_000 },
          )
          .toBe(source.indexOf('const answer'));
        await composer.press(key);
        await composer.pressSequentially(' Explain this.');
        await expect(composer.locator('p')).toHaveCount(1);
        await expect(composer.locator('p')).toHaveText(preceding ? 'Existing text Explain this.' : ' Explain this.');
        await expect(composer.locator(':scope > :first-child')).toHaveJSProperty('tagName', 'P');
        await expect(composer.locator('pre')).toHaveText('const answer = 42;');
        await composer.press('Enter');
        expect(await page.evaluate(() => window.composerTest.calls[0])).toBe(
          (preceding ? 'Existing text Explain this.' : ' Explain this.') + '\n\n```ts\nconst answer = 42;\n```',
        );
      }
    } finally {
      await page.close();
    }
  },
);

it.each(['ArrowUp', 'ArrowLeft'])('escapes an empty code block backwards with %s', async key => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('```');
    await composer.press('Shift+Enter');
    await composer.press(key);
    await composer.pressSequentially('Before code');
    await expect(composer.locator('p')).toHaveText('Before code');
    await expect(composer.locator('pre')).toHaveText('');
    await expect(composer.locator(':scope > :first-child')).toHaveJSProperty('tagName', 'P');
  } finally {
    await page.close();
  }
});

it('keeps normal arrow navigation and selection inside code blocks', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: script });
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('```');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('ab');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('cd');
    /** @param {string} key */
    const move = async key => {
      const before = await page.evaluate(() => window.composerTest.snapshot().document.from);
      await composer.press(key);
      await expect
        .poll(() => page.evaluate(() => window.composerTest.snapshot().document.from), { timeout: 10_000 })
        .not.toBe(before);
    };
    // ProseMirror briefly suppresses DOM selection updates after typing.
    // Establish the starting caret once its selection observer is listening again.
    await expect
      .poll(
        () =>
          composer.locator('pre code').evaluate(code => {
            const range = document.createRange();
            range.selectNodeContents(code);
            range.collapse(true);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return window.composerTest.snapshot().document.from;
          }),
        { timeout: 10_000 },
      )
      .toBe(4);
    await move('ArrowRight');
    await composer.pressSequentially('X');
    await expect(composer.locator('pre')).toHaveText('aXb\ncd', { timeout: 10_000 });
    await move('ArrowDown');
    await composer.pressSequentially('Y');
    await expect(composer.locator('pre')).toHaveText('aXb\ncdY', { timeout: 10_000 });
    await composer.press('Shift+ArrowLeft');
    await expect.poll(() => page.evaluate(() => window.getSelection().toString()), { timeout: 10_000 }).toBe('Y');
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const { from, to } = window.composerTest.snapshot().document;
            return to - from;
          }),
        { timeout: 10_000 },
      )
      .toBe(1);
    await composer.press('ArrowRight');
    await composer.pressSequentially('Z');
    await expect(composer.locator('pre')).toHaveText('aXb\ncdYZ', { timeout: 10_000 });
    await expect(composer.locator('p')).toHaveCount(0);
  } finally {
    await page.close();
  }
});

it.each([280, 1000])(
  'shows compact @ suggestions at %i px and attaches the hovered file without losing editor focus',
  async width => {
    const page = await newCoveredPage(browser, { viewport: { width: 1200, height: 800 } });
    try {
      await page.setContent(
        `<div id="root" style="width:${width}px;padding-top:400px;container-type:inline-size"></div>`,
      );
      await page.addScriptTag({ content: script });
      await page.evaluate(() =>
        window.composerTest.setContextCandidates([
          { uri: 'file:///src/runtime/AgentRuntime.ts', path: 'src/runtime/AgentRuntime.ts' },
          { uri: 'file:///src/chat/AgentMode.ts', path: 'src/chat/AgentMode.ts' },
        ]),
      );
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.pressSequentially('@');
      const list = page.getByRole('listbox', { name: 'Files and folders to attach' });
      const option = list.getByRole('option', { name: 'src/chat/AgentMode.ts', exact: true });
      await option.hover();
      await expect(option).toHaveAttribute('aria-selected', 'true');
      await expect(composer).toBeFocused();
      await expect(composer).toHaveAttribute('aria-activedescendant', await option.getAttribute('id'));
      await expect(option.locator('span').first()).toHaveText('AgentMode.ts');
      await expect(option.locator('span').last()).toHaveText('src/chat/');
      const bounds = await list.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 8);
      const preview = page.locator('[data-dropdown] > [aria-hidden="true"]');
      if (width === 1000) {
        await expect(preview).toBeVisible();
        await expect(preview).toContainText('chat');
        const previewBounds = await preview.boundingBox();
        expect(previewBounds.x).toBeGreaterThan(bounds.x + bounds.width);
      } else await expect(preview).toBeHidden();
      await option.click();
      await expect(list).toHaveCount(0);
      await expect(composer).toContainText('AgentMode.ts');
      await expect(composer).toBeFocused();
      await composer.press('Enter');
      expect(await page.evaluate(() => window.composerTest.captures[0][0].path)).toBe('src/chat/AgentMode.ts');
    } finally {
      await page.close();
    }
  },
  10000,
);

it('scrolls @ suggestions with the keyboard and dismisses them with Escape', async () => {
  const page = await newCoveredPage(browser);
  try {
    await page.setContent('<div id="root" style="padding-top:400px"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() =>
      window.composerTest.setContextCandidates(
        Array.from({ length: 30 }, (_, index) => ({
          uri: `file:///src/file${index}.ts`,
          path: `src/file${index}.ts`,
        })),
      ),
    );
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('@');
    const list = page.getByRole('listbox', { name: 'Files and folders to attach' });
    await expect(list.getByRole('option')).toHaveCount(30);
    for (let index = 0; index < 18; index++) await composer.press('ArrowDown');
    const option = list.getByRole('option', { name: 'src/file18.ts', exact: true });
    await expect(option).toHaveAttribute('aria-selected', 'true');
    const bounds = await list.boundingBox();
    const row = await option.boundingBox();
    expect(row.y).toBeGreaterThanOrEqual(bounds.y);
    expect(row.y + row.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    await composer.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(composer).toHaveText('@');
    await composer.pressSequentially('not-found');
    await expect(page.getByText('No matching files', { exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
});

it('shows Tree outline only for folders and attaches their tree snapshot', async () => {
  const page = await newCoveredPage(browser, { viewport: { width: 1200, height: 800 } });
  try {
    await page.setContent('<div id="root" style="width:1000px;padding-top:400px;container-type:inline-size"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() =>
      window.composerTest.setContextCandidates([
        { uri: 'file:///workspace/src/index.ts', path: 'src/index.ts', kind: 'file' },
        { uri: 'file:///workspace/src', path: 'src/', kind: 'folder' },
        {
          uri: 'file:///workspace',
          path: './',
          name: 'workspace',
          kind: 'folder',
          ancestry: ['Users', 'pedro', 'workspace'],
        },
      ]),
    );
    const composer = page.getByRole('textbox', { name: 'Message Glyph' });
    await composer.pressSequentially('@');
    await page.getByRole('option', { name: 'src/index.ts', exact: true }).hover();
    await expect(page.getByText('Tree outline', { exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: './', exact: true }).hover();
    await expect(page.getByText('Tree outline', { exact: true })).toBeVisible();
    await expect(page.locator('[data-dropdown] > [aria-hidden="true"]')).toContainText('Users');
    await page.getByRole('option', { name: 'src/', exact: true }).click();
    await expect(composer).toBeFocused();
    await composer.press('Enter');
    const captured = await page.evaluate(() => window.composerTest.captures[0][0]);
    expect(captured.kind).toBe('folder');
    expect(captured.text).toBe('Directory tree: src\n  index.ts');
  } finally {
    await page.close();
  }
});
