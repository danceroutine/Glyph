import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceImportPath } from '#scripts/imports/source-import-path.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));

describe(sourceImportPath, () => {
  it('returns non-alias specifiers unchanged', () => {
    expect(sourceImportPath('./sibling.js', join(root, 'src/desktop/host/Fixture.ts'))).toBe('./sibling.js');
  });

  it('lowers aliases to relative JavaScript paths', () => {
    expect(sourceImportPath('#src/chat/AgentMode.ts', join(root, 'src/desktop/host/Fixture.ts'))).toBe(
      '../../chat/AgentMode.js',
    );
    expect(sourceImportPath('#src/desktop/host/View.tsx', join(root, 'src/desktop/host/Fixture.ts'))).toBe('./View.js');
  });

  it.each(['#src/', '#src/chat/../outside.ts', '#src/chat\\AgentMode.ts'])('rejects the invalid alias %s', alias => {
    expect(() => sourceImportPath(alias, 'Fixture.ts')).toThrow(`Invalid source alias ${alias} in Fixture.ts`);
  });

  it('rejects aliases that resolve outside the source tree', () => {
    expect(() => sourceImportPath('#src//etc/passwd', 'Fixture.ts')).toThrow(
      'Source alias escapes src: #src//etc/passwd',
    );
  });
});
