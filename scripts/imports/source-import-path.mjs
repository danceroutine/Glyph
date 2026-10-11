import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../src', import.meta.url));

/** Resolve source-only aliases before emit so artifacts remain independent of the checkout. */
export function sourceImportPath(specifier, file) {
  if (!specifier.startsWith('#src/')) return specifier;
  const suffix = specifier.slice('#src/'.length);
  if (!suffix || suffix.split(/[\\/]/).includes('..') || suffix.includes('\\'))
    throw new Error(`Invalid source alias ${specifier} in ${file}`);
  const target = resolve(sourceRoot, suffix).replace(/\.tsx?$/, '.js');
  const inside = relative(sourceRoot, target);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Source alias escapes src: ${specifier}`);
  let path = relative(dirname(file), target).split(sep).join('/');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
}
