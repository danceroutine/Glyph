import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { WorkspaceRootSelections } from '../WorkspaceRootSelections.ts';

describe(WorkspaceRootSelections, () => {
  it('releases descriptors on disposal and when the selected route fails the initial check', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'glyph-selected-')));
    onTestFinished(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });
    const other = join(root, 'other');
    fs.mkdirSync(other);
    const close = vi.spyOn(fs, 'closeSync');
    const selections = new WorkspaceRootSelections();
    const selected = selections.select(root);
    expect(() => selections.select(other, root)).toThrow('workspace folder changed');
    expect(close).toHaveBeenCalledTimes(1);
    selections.assertCurrent(root);
    expect(() => {
      selections.assertCurrent(other);
    }).toThrow('no longer selected');
    selected.assertCurrent();
    selections[Symbol.dispose]();
    selections[Symbol.dispose]();
    expect(close).toHaveBeenCalledTimes(2);
    expect(selected.assertCurrent).toThrow('selection has ended');
    expect(() => selections.select(other)).toThrow('selection has ended');
  });
});
