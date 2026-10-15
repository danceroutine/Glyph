import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('cleans upstream Git hooks after a failed install before exiting with its status', async () => {
  const result = await build({
    entryPoints: ['scripts/code-oss/run.mjs'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    define: { 'import.meta.url': JSON.stringify(new URL('../run.mjs', import.meta.url).href) },
    banner: { js: "process.argv = ['node', 'run.mjs', 'install'];" },
    plugins: [
      {
        name: 'inert-install',
        setup(builder) {
          builder.onResolve({ filter: /^(node:fs\/promises|node:child_process)$|git-hooks\.mjs$/ }, args => ({
            path: args.path,
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
            if (args.path === 'node:fs/promises')
              return {
                contents:
                  'export async function readFile() { return \'{"node":"fixture"}\'; } export async function stat() { return {}; }',
              };
            if (args.path === 'node:child_process')
              return { contents: 'export function spawnSync() { return { status: 7 }; }' };
            return {
              contents: "export async function removeLeakedCodeOssHuskyHooks() { console.log('cleanup'); return []; }",
            };
          });
        },
      },
    ],
  });
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', result.outputFiles[0].text], {
    encoding: 'utf8',
  });
  expect(run.status).toBe(7);
  expect(run.stdout.trim().split('\n')).toEqual(['cleanup', 'cleanup']);
});
