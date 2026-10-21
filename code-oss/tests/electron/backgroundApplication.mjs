import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../../.code-oss/src', import.meta.url));
const artifactsRoot = fileURLToPath(new URL('../../../.artifacts/code-oss-integration', import.meta.url));

function bundleName() {
  return `${JSON.parse(readFileSync(join(sourceRoot, 'product.json'), 'utf8')).nameLong}.app`;
}

export function backgroundExecutablePath() {
  const product = JSON.parse(readFileSync(join(sourceRoot, 'product.json'), 'utf8'));
  return join(artifactsRoot, bundleName(), 'Contents', 'MacOS', product.nameShort);
}

export default function prepareBackgroundApplication() {
  if (process.platform !== 'darwin') return;
  const original = join(sourceRoot, '.build', 'electron', bundleName());
  const copy = join(artifactsRoot, bundleName());
  const marker = join(copy, 'Contents', 'Info.plist');
  if (existsSync(marker) && statSync(marker).mtimeMs >= statSync(join(original, 'Contents', 'Info.plist')).mtimeMs) {
    const background = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSBackgroundOnly', marker], {
      encoding: 'utf8',
    }).trim();
    if (background === 'true') return;
  }
  rmSync(copy, { recursive: true, force: true });
  execFileSync('mkdir', ['-p', artifactsRoot]);
  execFileSync('cp', ['-cR', original, copy]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSBackgroundOnly bool true', marker]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', copy], { stdio: 'ignore' });
}
