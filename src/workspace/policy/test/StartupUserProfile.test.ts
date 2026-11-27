import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { StartupUserProfile } from '../StartupUserProfile.ts';

function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'glyph-startup-profile-')));
  onTestFinished(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const configured = join(base, 'configured');
  const physical = join(base, 'physical');
  const select = () => {
    const selected = new StartupUserProfile(configured);
    onTestFinished(() => {
      selected.dispose();
    });
    return selected;
  };
  return { base, configured, physical, select };
}

describe(StartupUserProfile, () => {
  it('keeps the selected directory and its live contents after the configured alias changes', () => {
    const { base, configured, physical, select } = fixture();
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, configured);
    const selected = select();
    fs.unlinkSync(configured);
    fs.symlinkSync(base, configured);
    fs.writeFileSync(join(physical, 'edit'), 'live');
    selected.verify();
    expect(selected.path).toBe(physical);
    expect(fs.readFileSync(join(selected.path, 'edit'), 'utf8')).toBe('live');
    fs.renameSync(physical, join(base, 'old'));
    expect(() => selected.ensureDirectory()).toThrow('removed or replaced');
    fs.mkdirSync(physical);
    expect(() => selected.verify()).toThrow('removed or replaced');
    selected.dispose();
    expect(() => selected.verify()).toThrow('closed');
  });

  it('creates a missing link target beneath the selected ancestor with private permissions', () => {
    const { base, configured, physical, select } = fixture();
    fs.symlinkSync('physical/profile', configured);
    const selected = select();
    expect(selected.path).toBe(join(physical, 'profile'));
    selected.verify();
    expect(fs.existsSync(physical)).toBe(false);
    fs.mkdirSync(physical);
    selected.verify();
    fs.unlinkSync(configured);
    fs.symlinkSync(base, configured);
    selected.ensureDirectory();
    expect(fs.statSync(selected.path).mode & 0o777).toBe(0o700);
    selected.ensureDirectory();
    fs.rmdirSync(selected.path);
    expect(() => selected.ensureDirectory()).toThrow('removed or replaced');
  });

  it('rejects a new redirect below the verified ancestor and invalid startup selections', () => {
    const { base, configured, physical, select } = fixture();
    const selected = select();
    fs.symlinkSync(base, configured);
    expect(() => selected.ensureDirectory()).toThrow('removed or replaced');
    fs.unlinkSync(configured);
    fs.writeFileSync(configured, 'file');
    expect(() => select()).toThrow('must select a directory');
    fs.unlinkSync(configured);
    fs.symlinkSync(physical, configured);
    fs.symlinkSync(configured, physical);
    expect(() => select()).toThrow('Too many');
  });

  it('releases a provisional handle if a parent changes while opening the new directory', () => {
    const { base, configured, physical, select } = fixture();
    fs.mkdirSync(physical);
    fs.symlinkSync(join(physical, 'child'), configured);
    const selected = select();
    const open = fs.openSync;
    const swap = vi.spyOn(fs, 'openSync').mockImplementationOnce((...args) => {
      const handle = open(...args);
      fs.renameSync(physical, join(base, 'moved'));
      return handle;
    });
    try {
      expect(() => selected.ensureDirectory()).toThrow('removed or replaced');
    } finally {
      swap.mockRestore();
    }
  });
});
