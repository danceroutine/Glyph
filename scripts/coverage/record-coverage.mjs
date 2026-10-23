/// <reference path="./v8-types.d.ts" />
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasErrorCode } from '#scripts/support/hasErrorCode.mjs';
import { processCoverageSchema } from './coverage-schema.mjs';

/** @typedef {{ result: (import('node:inspector').Profiler.ScriptCoverage & { source?: string })[] }} ProcessCoverage */

const glyphScript = /\/glyph-desktop-host\/dist\/|\/vs\/platform\/glyph\/|\/vs\/workbench\/contrib\/glyph\//u;
const inlineSourceMap = '//# sourceMappingURL=data:';

/** @param {string} url */
export function isGlyphScript(url) {
  return glyphScript.test(url) && !url.includes('/node_modules/');
}

/** @param {string} directory */
export async function readProcessCoverage(directory) {
  const names = await readdir(directory, { recursive: true }).catch(error => {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  });
  const processes = [];
  for (const name of names
    .filter(name => name.endsWith('.json'))
    .toSorted((left, right) => left.localeCompare(right))) {
    const { result } = processCoverageSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
    processes.push({ result });
  }
  return processes;
}

/** @param {string} file @param {ProcessCoverage[]} processes */
async function mergeIntoFile(file, processes) {
  const previous = await readFile(file, 'utf8').then(
    text => processCoverageSchema.parse(JSON.parse(text)),
    error => {
      if (hasErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    },
  );
  const merged = mergeProcessCovs(previous ? [previous, ...processes] : processes);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(merged));
}

/** @param {string} file @param {ProcessCoverage[]} processes */
export async function accumulateProcessCoverage(file, processes) {
  await mergeIntoFile(
    file,
    processes.map(({ result }) => ({
      result: result.filter(script => isGlyphScript(script.url)).map(({ source: _source, ...script }) => script),
    })),
  );
}

/** @param {string} directory @param {string} file @param {(import('node:inspector').Profiler.ScriptCoverage & { source?: string })[]} scripts */
export async function accumulateBundleCoverage(directory, file, scripts) {
  const result = [];
  for (const { source, scriptId, functions } of scripts) {
    if (!source?.includes(inlineSourceMap)) continue;
    const path = join(directory, 'sources', `${createHash('sha256').update(source).digest('hex')}.js`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, { flag: 'wx' }).catch(error => {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    });
    result.push({ scriptId, url: pathToFileURL(path).href, functions });
  }
  await mergeIntoFile(join(directory, file), [{ result }]);
}
