import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.use({ scriptedProvider: true });
async function prepare(glyph) {
  const git = (...args) => execFileSync('git', args, { cwd: glyph.workspace });
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Glyph Fixture');
  await writeFile(join(glyph.workspace, 'review.ts'), 'const count = 1;\nconsole.log(count);\n');
  git('add', 'review.ts');
  git('commit', '-m', 'initial');
  await writeFile(join(glyph.workspace, 'review.ts'), 'const count = 0;\nconsole.log(10 / count);\n');
  git('commit', '-am', 'change');
  await glyph.command('Glyph: Open Agent Review');
  await expect(glyph.page.getByRole('button', { name: 'Find Issues', exact: true })).toBeEnabled({ timeout: 30000 });
}
const findings = [
  { path: 'review.ts', line: 2, title: 'Division by zero', body: 'The divisor is now zero, so this prints Infinity.' },
  {
    path: 'review.ts',
    line: 1,
    title: 'Count loses its original value',
    body: 'The zero initialization changes the recorded count.',
  },
];
it('shows streamed findings, opens native diff comments, dismisses one and fixes in the active chat', async ({
  glyph,
  provider,
}) => {
  await prepare(glyph);
  provider.enqueue({
    chunks: [
      '<glyph_review>\n' +
        findings.map(f => JSON.stringify(f)).join('\n') +
        '\n{"complete":true}\n</glyph_review>\nTwo issues found.',
    ],
    hold: true,
  });
  await glyph.page.getByRole('button', { name: 'Find Issues', exact: true }).click();
  const running = glyph.page.getByRole('button', { name: 'Reviewing', exact: true });
  await expect(running).toBeVisible();
  await running.hover();
  await expect(running).toHaveAttribute('title', 'Stop Review');
  await expect(glyph.userEntries).not.toContainText('JSON');
  expect(JSON.stringify(provider.requests[0].body.input)).toContain('<glyph_review>');
  await expect(glyph.page.getByRole('button', { name: 'Division by zero', exact: true })).toBeVisible();
  provider.release(0);
  await expect(glyph.page.getByRole('button', { name: 'Find Issues', exact: true })).toBeVisible();
  await glyph.page.getByRole('button', { name: 'Division by zero', exact: true }).click();
  await expect(glyph.page.locator('.monaco-diff-editor')).toBeVisible();
  const comments = glyph.page.getByRole('region', { name: 'Agent review comment' });
  await expect(comments).toHaveCount(2);
  const first = comments.filter({ hasText: 'Division by zero' });
  await expect(first).toContainText('prints Infinity');
  await comments
    .filter({ hasText: 'Count loses its original value' })
    .getByRole('button', { name: 'Dismiss', exact: true })
    .click();
  await expect(comments).toHaveCount(1);
  await expect(glyph.page.getByRole('button', { name: 'Count loses its original value', exact: true })).toHaveCount(0);
  // Fix targets the chat active now, even when it differs from the review's original chat.
  await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
  provider.enqueue({ chunks: ['I checked the current source and fixed this issue.'] });
  await first.getByRole('button', { name: 'Fix with Agent', exact: true }).click();
  await expect.poll(() => provider.requests.length).toBe(2);
  const input = JSON.stringify(provider.requests[1].body.input);
  expect(input).toContain('Division by zero');
  expect(input).toContain('review.ts:2');
  expect(input).toContain('10 / count');
  await expect(glyph.userEntries).toHaveCount(1);
  await expect(glyph.userEntries).toContainText('Fix this agent review issue');
  await expect(glyph.page.getByRole('button', { name: /thumbs/i })).toHaveCount(0);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await expect(glyph.page.getByRole('button', { name: 'Find Issues', exact: true })).toBeInViewport();
  const icon = glyph.page.locator('[aria-label="Review findings"] .file-icon');
  await expect(icon).toBeVisible();
  await expect
    .poll(() => icon.evaluate(element => getComputedStyle(element, '::before').content))
    .not.toMatch(/^(none|normal|""|)$/);
});
it('cancels the actual in-flight review from its hover stop action', async ({ glyph, provider }) => {
  await prepare(glyph);
  provider.enqueue({ chunks: ['Reviewing the captured comparison.'], hold: true });
  await glyph.page.getByRole('button', { name: 'Find Issues', exact: true }).click();
  await expect.poll(() => provider.requests.length).toBe(1);
  const running = glyph.page.getByRole('button', { name: 'Reviewing', exact: true });
  await running.hover();
  await running.click();
  await expect(glyph.page.getByRole('button', { name: 'Find Issues', exact: true })).toBeVisible();
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await expect(glyph.page.getByText('No issues found.', { exact: true })).toHaveCount(0);
});
