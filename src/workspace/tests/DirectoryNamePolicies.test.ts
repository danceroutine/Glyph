import fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DirectoryNamePolicies } from '#src/workspace/DirectoryNamePolicies.js';
import { readDirectoryNamePolicies } from '#src/workspace/readDirectoryNamePolicies.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { RulePathBatch } from '#src/instructions/rules/matchesAgentRulePath.js';

const sensitive = { caseSensitive: true, normalizesUnicode: true, foldsUnicode: false };
const insensitive = { caseSensitive: false, normalizesUnicode: true, foldsUnicode: true };
const temporary: string[] = [];
function directory() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'glyph-directory-policies-')));
  temporary.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('preserves response order and shares native requests for prospective directories on the same parent', () => {
  const root = directory();
  const nested = join(root, 'nested');
  mkdirSync(nested);
  const binary = join(root, 'metadata');
  writeFileSync(
    binary,
    '#!' +
      process.execPath +
      `\nconst rl = require('node:readline').createInterface({input:process.stdin});\nconst responses=[];rl.on('line', line=>{const request=JSON.parse(line);if(request.method!=='filesystemNamePolicy') process.exit(1);responses.unshift(JSON.stringify({id:request.id,result:{caseSensitive:request.params.endsWith('/nested'),normalizesUnicode:true,foldsUnicode:!request.params.endsWith('/nested')}}));});rl.on('close',()=>console.log(responses.join('\\n')));\n`,
    { mode: 0o755 },
  );
  expect(readDirectoryNamePolicies(binary, [])).toEqual([]);
  expect(readDirectoryNamePolicies(binary, [join(nested, 'new/child'), root, nested])).toEqual([
    sensitive,
    insensitive,
    sensitive,
  ]);
  writeFileSync(
    binary,
    '#!' +
      process.execPath +
      '\nconsole.log(JSON.stringify({id:99,result:{caseSensitive:true, normalizesUnicode:false,foldsUnicode:false}}));\n',
  );
  expect(() => readDirectoryNamePolicies(binary, [root])).toThrow('every directory');
});

it('rechecks directory identities across event-loop turns and shares probes for new children', async () => {
  const root = directory();
  mkdirSync(join(root, 'child'));
  const read = vi.fn((dirs: readonly string[]) => dirs.map(() => sensitive));
  const policies = new DirectoryNamePolicies(read, false);
  policies.remember(root, insensitive);
  policies.remember(join(root, 'missing'), sensitive);
  policies.prepare([root, join(root, 'child/new/file'), join(root, 'child/other')]);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]![0]).toHaveLength(1);
  expect(policies.get(join(root, 'child/missing'))).toBe(sensitive);
  expect(policies.get(root)).toBe(insensitive);
  await Promise.resolve();
  expect(policies.get(join(root, 'child'))).toBe(sensitive);
  expect(read).toHaveBeenCalledOnce();
  mkdirSync(join(root, 'new'));
  expect(policies.get(join(root, 'new'))).toBe(sensitive);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  'matches every literal and wildcard on its containing volume when the outer volume is sensitive=%s',
  outerSensitive => {
    const root = directory();
    const mounted = join(root, 'mounted');
    mkdirSync(join(mounted, 'Docs'), { recursive: true });
    writeFileSync(join(mounted, 'Docs/readme.ts'), '');
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((path: string, options: fs.StatSyncOptions) => {
      const info = stat(path, options);
      if (info && (path === mounted || path.startsWith(mounted + '/')))
        Object.assign(info, { dev: BigInt(info.dev) + 1n });
      return info;
    }) as typeof fs.statSync);
    const outer = outerSensitive ? sensitive : insensitive;
    const inner = outerSensitive ? insensitive : sensitive;
    const read = vi.fn((parents: readonly string[]) => parents.map(() => inner));
    const routes = new WorkspaceSourceRoutes([{ name: 'workspace', path: root, ...outer }], read);
    const paths = new InstructionPaths(outerSensitive, routes);
    const existing = 'mounted/Docs/readme.ts',
      future = 'mounted/Docs/new/deeper/readme.ts';
    const batch = new RulePathBatch([existing, future], paths);
    expect(batch.matching('.', ['**/*.TS'])).toEqual(outerSensitive ? [existing, future] : []);
    expect(batch.matching('.', ['mounted/**/R*.ts'])).toEqual(outerSensitive ? [existing, future] : []);
    expect(batch.matching('.', ['mounted/D*cs/**/r*.ts'])).toEqual([existing, future]);
    expect(batch.matching('.', ['mounted/d*cs/**/r*.ts'])).toEqual(outerSensitive ? [existing, future] : []);
    expect(batch.matching('.', ['MOU*/Docs/**/*.ts'])).toEqual(outerSensitive ? [] : [existing, future]);
    expect(batch.matching('mounted/Docs', ['**/*.ts'])).toEqual([existing, future]);
    expect(paths.key('mounted/Docs/new')).toBe(outerSensitive ? 'mounted/docs/new' : 'mounted/Docs/new');
    expect(routes.componentPolicies('../bad')).toBeUndefined();
    routes.prepare(['../bad']);
    expect(routes.componentPolicies(existing)).toEqual([outer, inner, inner]);
    expect(read).toHaveBeenCalledOnce();
  },
);

it('keeps the routed spelling of symlink destinations and uses only aliases of the existing directory', () => {
  const root = directory();
  const nested = join(root, 'nested');
  mkdirSync(join(nested, 'inner'), { recursive: true });
  const uriA = { name: 'A', path: root, ...insensitive },
    uriB = { name: 'B', path: nested, ...insensitive };
  symlinkSync(nested, join(root, 'sameDepth'), 'dir');
  symlinkSync(join(nested, 'inner'), join(root, 'deep'), 'dir');
  writeFileSync(join(nested, 'a'), '');
  const routes = new WorkspaceSourceRoutes([uriA, uriB, { name: 'unconfigured', path: join(root, 'missing') }], dirs =>
    dirs.map(() => insensitive),
  );
  expect(routes.equivalents('A')).toEqual(['A']);
  expect(routes.equivalents('A/unknown/a')).toEqual(['A/unknown/a']);
  expect(routes.equivalents('A/sameDepth/a')).toEqual(['A/sameDepth/a']);
  expect(routes.storedSpelling('A/sameDepth/a')).toBe('A/sameDepth/a');
  expect(routes.storedSpelling('A/deep/new')).toBe('A/deep/new');
  expect(routes.storedSpelling('A/nested/a')).toBe('A/nested/a');
  expect(routes.physicalScopeKey('A/nested')).toBe(routes.physicalScopeKey('B'));
  expect(routes.componentPolicies('B/a')).toEqual([insensitive]);
  expect(routes.physicalScopeKey('unknown')).toBeUndefined();
  expect(routes.physicalScopeKey('A/nested/a')).toBeUndefined();
  const canonical = vi.spyOn(realpathSync, 'native').mockReturnValueOnce(join(root, 'nested', 'a'));
  expect(routes.storedSpelling('A/nested/a')).toBe('A/nested/a');
  canonical.mockRestore();
});

it('releases old directory metadata after a large catalog batch', async () => {
  const root = directory();
  const sample = fs.statSync(root, { bigint: true });
  vi.spyOn(fs, 'statSync').mockImplementation(((path: string) => ({
    ...sample,
    ino: BigInt(path),
    isDirectory: () => true,
  })) as typeof fs.statSync);
  const read = vi.fn((parents: readonly string[]) => parents.map(() => sensitive));
  const policies = new DirectoryNamePolicies(read, false);
  policies.prepare(Array.from({ length: 32_769 }, (_, i) => String(i)));
  await Promise.resolve();
  expect(policies.get('5')).toBe(sensitive);
  expect(read).toHaveBeenCalledTimes(2);
});

it('prepares the ancestors above an overlapping inner attachment in the same native batch', () => {
  const root = directory();
  const middle = join(root, 'a', 'b');
  const inner = join(middle, 'c');
  mkdirSync(inner, { recursive: true });
  const stat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((path: string, options: fs.StatSyncOptions) => {
    const info = stat(path, options);
    if (info && typeof info.dev === 'bigint' && path.startsWith(root + '/')) {
      const depth = path.slice(root.length + 1).split('/').length;
      Object.assign(info, { dev: info.dev + BigInt(depth) });
    }
    return info;
  }) as typeof fs.statSync);
  const read = vi.fn((parents: readonly string[]) => parents.map(() => sensitive));
  const routes = new WorkspaceSourceRoutes(
    [
      { name: 'Outer', path: root, ...insensitive },
      { name: 'Inner', path: inner, ...insensitive },
    ],
    read,
  );
  routes.prepare(['Inner/file']);
  expect(read).toHaveBeenCalledOnce();
  expect(new Set(read.mock.calls[0]![0])).toEqual(new Set([middle, join(root, 'a')]));
  expect(routes.scopeKey('Outer/a/b/c/FILE', false)).toBe('Outer/a/b/c/file');
  expect(read).toHaveBeenCalledOnce();
});
