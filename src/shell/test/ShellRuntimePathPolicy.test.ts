import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertShellRuntimePathIsolation, pathsOverlap } from '../ShellRuntimePathPolicy.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(assertShellRuntimePathIsolation, () => {
  it('rejects direct and symlinked state or trace overlap in either direction', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'glyph-runtime-paths-'));
    temporaryDirectories.push(fixture);
    const project = join(fixture, 'project');
    const outside = join(fixture, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(project, join(outside, 'project-alias'));

    expect(() => assertShellRuntimePathIsolation([project], join(project, '.glyph'), join(outside, 'trace'))).toThrow(
      'GLYPH_CONFIG_DIR',
    );
    expect(() => assertShellRuntimePathIsolation([project], outside, join(project, 'trace.log'))).toThrow(
      'CHAT_TRACE_FILE',
    );
    expect(() =>
      assertShellRuntimePathIsolation([project], outside, join(outside, 'project-alias', 'trace.log')),
    ).toThrow('CHAT_TRACE_FILE');
    expect(() => assertShellRuntimePathIsolation([project], outside, join(outside, 'trace.log'))).not.toThrow();
    expect(pathsOverlap(project, join(project, 'nested'))).toBe(true);
  });
});
