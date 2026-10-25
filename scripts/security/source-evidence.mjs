import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Hash source bytes and link identities without following source-tree aliases.
 * @param {string} root
 * @param {(command: string, args: string[], options: {cwd: string, encoding: 'utf8'}) => string} git
 */
export async function sourceEvidence(root, git = execFileSync) {
  const revision = git('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const listed = git('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  const files = [];
  for (const path of [...new Set(listed.split('\0').filter(Boolean))].toSorted()) {
    let bytes;
    let mode;
    try {
      const info = await lstat(join(root, path));
      mode = info.mode;
      bytes = info.isSymbolicLink() ? await readlink(join(root, path)) : await readFile(join(root, path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = '<deleted>';
      mode = 0;
    }
    files.push({ path, mode, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { revision, fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}
