import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { it, expect, onTestFinished } from 'vitest';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

const openMutations = (root: string) =>
  NativeWorkspaceMutations.open(resolve('target/release/glyph-workspace-mutations'), root);

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
  const { root, location, catalog, state, install } = await aSkillLifecycle(openMutations);
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
  const { root, location, manager, state, install } = await aSkillLifecycle(openMutations);
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

it('refuses a different directory mounted at the same configured path and preserves an occupied destination', async () => {
  const { root, location } = await aSkillLifecycle(openMutations);
  const { mutations } = location;
  await mutations.ensureDirectory('skills/first');
  await mutations.ensureDirectory('skills/occupied');
  await writeFile(join(root, 'skills/occupied/notes'), 'Keep this package');
  await expect(mutations.renameExclusive('skills/first', 'skills/occupied')).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(root, 'skills/occupied/notes'), 'utf8')).toBe('Keep this package');
  const prior = root + '-prior';
  await rename(root, prior);
  onTestFinished(() => rm(prior, { recursive: true, force: true }));
  await mkdir(root, { mode: 0o700 });
  await expect(mutations.ensureDirectory('skills/example')).rejects.toMatchObject({ code: 'ESTALE' });
  await expect(stat(join(root, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
});
