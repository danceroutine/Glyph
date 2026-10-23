import { build } from 'esbuild';
import { beforeAll, afterAll, it } from 'vitest';
import { chromium, expect } from '#scripts/code-oss/tests/support/playwright.mjs';
import { coverageBuildOptions, newCoveredPage } from '#scripts/code-oss/tests/support/coverage.mjs';
/** @type {import('@playwright/test').Browser} */
let browser;
/** @type {string} */
let script;
beforeAll(async () => {
  script = (
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
        import { render, h } from 'preact';
        import { WiredGlyphGoalRow } from './code-oss/ui/GlyphGoalRow/GlyphGoalRow.wired.tsx';
        import { WiredGlyphApprovalCard } from './code-oss/ui/GlyphApprovalCard/GlyphApprovalCard.wired.tsx';
        window.calls = [];
        const record = name => async (...args) => {
          window.calls.push([name, ...args]);
          if (window.failure) throw new Error(window.failure);
        };
        const actions = {
          pauseGoal: record('pauseGoal'),
          resumeGoal: record('resumeGoal'),
          clearGoal: record('clearGoal'),
          decideApproval: record('decideApproval'),
        };
        window.showGoal = ({ goal, readOnly = false, now }) =>
          render(h(WiredGlyphGoalRow, { chatId: 'chat', goal, readOnly, actions, ...(now ? { now: () => window.clock } : {}) }),
            document.getElementById('root'));
        window.showApproval = request =>
          render(h(WiredGlyphApprovalCard, { request, chatId: 'chat', runId: 'run', actions, disabled: false }),
            document.getElementById('root'));
      `,
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      ...coverageBuildOptions,
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } },
    })
  ).outputFiles[0].text;
  browser = await chromium.launch();
}, 30000);
afterAll(async () => {
  await browser?.close();
});

async function mount() {
  const page = await newCoveredPage(browser);
  await page.setContent('<div id="root" style="width:360px"></div>');
  await page.addScriptTag({ content: script });
  return page;
}

it('shows an active goal with its running time and pauses or clears that exact goal', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      window.clock = Date.parse('2026-10-20T14:03:05.000Z');
      window.showGoal({
        now: true,
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 2,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
          activeSince: '2026-10-20T14:00:00.000Z',
        },
      });
    });
    const row = page.getByRole('region', { name: 'Goal' });
    await expect(row).toContainText('Make CI green');
    await expect(row).toContainText('Active');
    await expect(row.getByLabel('Worked for 3m 5s')).toBeVisible();
    await page.evaluate(() => {
      window.clock += 2000;
    });
    await expect(row.getByLabel('Worked for 3m 7s')).toBeVisible({ timeout: 3000 });

    await row.getByRole('button', { name: 'Pause goal' }).click();
    await row.getByRole('button', { name: 'Clear goal' }).click();

    await expect
      .poll(() => page.evaluate(() => window.calls))
      .toEqual([
        ['pauseGoal', 'chat', 'goal'],
        ['clearGoal', 'chat', 'goal'],
      ]);
  } finally {
    await page.close();
  }
});

it('explains why a goal paused and offers to resume it', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.showGoal({
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'paused',
          pauseReason: 'stalled',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 3,
          idleContinuationsWithoutToolCalls: 3,
          activeDurationMs: 45_000,
        },
      }),
    );
    const row = page.getByRole('region', { name: 'Goal' });
    await expect(row).toContainText('Paused · No progress');
    await expect(row.getByLabel('Worked for 45s')).toBeVisible();

    await row.getByRole('button', { name: 'Resume goal' }).click();

    await expect.poll(() => page.evaluate(() => window.calls)).toEqual([['resumeGoal', 'chat', 'goal']]);
  } finally {
    await page.close();
  }
});

it('keeps a completed goal visible with its total time until it is cleared', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.showGoal({
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'complete',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 9,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 3_725_000,
        },
      }),
    );
    const row = page.getByRole('region', { name: 'Goal' });

    await expect(row).toContainText('Complete');
    await expect(row.getByLabel('Worked for 1h 2m')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Pause goal' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Resume goal' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Clear goal' })).toBeEnabled();
  } finally {
    await page.close();
  }
});

it('disables goal controls in a window that does not own the workspace', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.showGoal({
        readOnly: true,
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
          activeSince: '2026-10-20T14:00:00.000Z',
        },
      }),
    );
    const row = page.getByRole('region', { name: 'Goal' });

    await expect(row.getByRole('button', { name: 'Pause goal' })).toBeDisabled();
    await expect(row.getByRole('button', { name: 'Clear goal' })).toBeDisabled();
  } finally {
    await page.close();
  }
});

it('reports a rejected goal action and lets the human try again', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      window.failure = 'This goal is no longer current.';
      window.showGoal({
        goal: {
          id: 'goal',
          objective: 'Make CI green',
          status: 'active',
          createdAt: '2026-10-20T14:00:00.000Z',
          continuationCount: 0,
          idleContinuationsWithoutToolCalls: 0,
          activeDurationMs: 0,
          activeSince: '2026-10-20T14:00:00.000Z',
        },
      });
    });
    const row = page.getByRole('region', { name: 'Goal' });

    await row.getByRole('button', { name: 'Pause goal' }).click();

    await expect(row.getByRole('alert')).toHaveText('This goal is no longer current.');
    await expect(row.getByRole('button', { name: 'Pause goal' })).toBeEnabled();
  } finally {
    await page.close();
  }
});

it('asks the human to start or decline an agent-proposed goal', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.showApproval({
        id: 'approval',
        title: 'Start a goal?',
        detail: 'Make CI green',
        sandboxed: false,
        goal: { objective: 'Make CI green' },
      }),
    );
    const card = page.getByRole('region', { name: 'Goal approval' });
    await expect(card).toContainText('Start a goal?');
    await expect(card).toContainText('Make CI green');
    await expect(card.getByRole('button', { name: 'Always Run' })).toHaveCount(0);

    await card.getByRole('button', { name: 'Start goal' }).click();

    await expect
      .poll(() => page.evaluate(() => window.calls))
      .toEqual([['decideApproval', 'chat', 'run', 'approval', 'allow_once']]);
  } finally {
    await page.close();
  }
});

it('declines an agent-proposed goal without arming it', async () => {
  const page = await mount();
  try {
    await page.evaluate(() =>
      window.showApproval({
        id: 'approval',
        title: 'Start a goal?',
        detail: 'Make CI green',
        sandboxed: false,
        goal: { objective: 'Make CI green' },
      }),
    );

    await page.getByRole('region', { name: 'Goal approval' }).getByRole('button', { name: 'Decline' }).click();

    await expect
      .poll(() => page.evaluate(() => window.calls))
      .toEqual([['decideApproval', 'chat', 'run', 'approval', 'deny']]);
  } finally {
    await page.close();
  }
});
