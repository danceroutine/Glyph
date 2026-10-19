import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, it } from 'vitest';

const requireUpstream = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
const { chromium, expect } = requireUpstream('@playwright/test');
let browser;
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
        const actions = {
          composer: new GlyphComposerState(),
          context: { selectFiles: () => new Promise(resolve => { selectFiles = resolve; }), searchFiles: async query => [{ uri: attachment.uri, path: attachment.path }].filter(file => file.path.includes(query)), captureFile: async () => attachment, openAttachment: async () => {}, checkAttachment: async () => undefined, refreshAttachment: async value => ({ ...value, text: 'Updated capture' }) },
          send(text, attachments) { captures.push(attachments); calls.push(text); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
          steer: async text => { steering.push(text); },
          sendImmediately: async text => { menuActions.push(text); },
          openMessageSettings: () => { menuActions.push('settings'); },
          moveQueuedToNewChat: async id => { menuActions.push('new-chat'); actions.composer.removeQueued(id); },
          cancel() {}
        };
        window.composerTest = {
          calls, captures, steering, menuActions,
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
      const page = await browser.newPage();
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
        await expect(composer).toHaveText('Newer draft', { timeout: 500 });
        await expect(page.getByRole('region', { name: 'Unsent messages' })).toContainText('Original message');
      } finally {
        await page.close();
      }
    },
  );
  it('retains a failed message separately from a newer draft and lets the user edit either without losing the other', async () => {
    const page = await browser.newPage();
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
    const page = await browser.newPage();
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
    const page = await browser.newPage();
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
    const page = await browser.newPage();
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
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      const attach = page.getByRole('button', { name: 'Attach file', exact: true });
      await composer.fill('before  after');
      for (let index = 0; index < 6; index++) await composer.press('ArrowLeft');
      await attach.click();
      await expect(attach).toBeDisabled();
      await expect(page.getByRole('listbox', { name: 'Files to attach' })).toHaveCount(0);
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
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: script });
      const composer = page.getByRole('textbox', { name: 'Message Glyph' });
      await composer.fill('before  after');
      for (let index = 0; index < 6; index++) await composer.press('ArrowLeft');
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
    const page = await browser.newPage();
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
    const page = await browser.newPage();
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
    const page = await browser.newPage();
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
        element.closest('[contenteditable]').focus();
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
  const page = await browser.newPage();
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
  const page = await browser.newPage();
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
  const page = await browser.newPage();
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
  const page = await browser.newPage();
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
