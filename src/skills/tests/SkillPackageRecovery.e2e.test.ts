import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { it, expect, onTestFinished } from 'vitest';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

function childTransaction(root: string, scenario: string) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/skillTransactionProcess.mjs', import.meta.url)),
    [root, scenario],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  onTestFinished(() => {
    if (child.exitCode === null) child.kill();
  });
  return child;
}
it('recovers a process that exited after publishing the candidate and before recording its provenance', async () => {
  const { root, location, catalog, state, install } = await aSkillLifecycle();
  const skill = await install();
  const child = childTransaction(root, 'crash');
  expect((await once(child, 'exit'))[0]).toBe(53);
  expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Changed in child');
  expect(state.installations.get(skill.id)?.source).toBe('Local fixture');
  const manager = new SkillPackageManager([location], catalog, state);
  await manager.recover();
  await manager.recover();
  expect(state.installations.get(skill.id)?.source).toBe('Child import');
});
it('orders a second process installing a shared skill after the first process has forgotten its old record', async () => {
  const { root, location, manager, state, install } = await aSkillLifecycle();
  await install();
  const child = childTransaction(root, 'hold-removal');
  const done = once(child, 'exit');
  await once(child, 'message');
  const preview = await manager.prepare(location.id, aSkillDraft('Installed concurrently'));
  const applying = manager.apply(preview.id);
  await new Promise(accept => {
    setTimeout(accept, 60);
  });
  await expect(stat(join(root, 'skills/example'))).rejects.toMatchObject({ code: 'ENOENT' });
  child.send('release');
  expect((await done)[0]).toBe(0);
  await applying;
  expect(state.installations.get('user:glyph:skills/example')?.revision).toBe(preview.revision);
  expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Installed concurrently');
});
