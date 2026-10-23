/// <reference path="./v8-types.d.ts" />
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import astV8ToIstanbul from 'ast-v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'vite';
import { sourceMapSchema } from './coverage-schema.mjs';

/** @typedef {import('istanbul-lib-coverage').FileCoverageData} FileCoverageData */
/** @typedef {Record<string, FileCoverageData>} CoverageData */
/** @typedef {NonNullable<Parameters<typeof astV8ToIstanbul>[0]['sourceMap']>} SourceMap */

const desktopScheme = 'vscode-file://vscode-app';

/** @param {string} url */
export function toFilePath(url) {
  if (url.startsWith(`${desktopScheme}/`)) return decodeURIComponent(url.slice(desktopScheme.length));
  if (url.startsWith('file://')) return fileURLToPath(url);
  return undefined;
}

/** @param {string} path @param {string} repositoryRoot */
export function toRepositorySource(path, repositoryRoot) {
  const generated = join(repositoryRoot, '.code-oss', 'src', 'src', 'vs') + sep;
  if (!path.startsWith(generated)) return path;
  const suffix = path.slice(generated.length).split(sep).join('/');
  if (suffix === 'platform/glyph/chat/AgentMode.ts') return join(repositoryRoot, 'src', 'chat', 'AgentMode.ts');
  if (suffix === 'platform/glyph/reviewing/AgentReview.ts')
    return join(repositoryRoot, 'src', 'reviewing', 'AgentReview.ts');
  if (suffix === 'platform/glyph/shared/validators/isRecord.ts')
    return join(repositoryRoot, 'src', 'shared', 'validators', 'isRecord.ts');
  if (suffix.startsWith('platform/glyph/common/')) return undefined;
  return join(repositoryRoot, 'code-oss', 'overlay', 'src', 'vs', ...suffix.split('/'));
}

/** @param {string} path */
export async function readGeneratedSource(path) {
  const code = await readFile(path, 'utf8');
  const marker = '//# sourceMappingURL=';
  const offset = code.lastIndexOf(marker);
  if (offset === -1) return { code, map: undefined };
  const reference = code.slice(offset + marker.length).trim();
  if (reference.length === 0 || /\s/u.test(reference)) return { code, map: undefined };
  if (reference.startsWith('data:')) {
    const payload = reference.slice(reference.indexOf(',') + 1);
    return { code, map: sourceMapSchema.parse(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))) };
  }
  return { code, map: sourceMapSchema.parse(JSON.parse(await readFile(resolve(dirname(path), reference), 'utf8'))) };
}

/** @param {import('./record-coverage.mjs').ProcessCoverage[]} processes @param {{ repositoryRoot: string, files: Set<string> }} options */
export async function convertProcessCoverage(processes, { repositoryRoot, files }) {
  /** @type {Record<string, FileCoverageData[]>} */
  const converted = {};
  for (const script of mergeProcessCovs(processes).result) {
    const path = toFilePath(script.url);
    if (!path) continue;
    const { code, map } = await readGeneratedSource(path);
    if (!map) continue;
    const sources = map.sources.map(source => {
      const generated = resolve(dirname(path), map.sourceRoot ?? '', source);
      return toRepositorySource(generated, repositoryRoot) ?? generated;
    });
    if (!sources.some(source => files.has(source))) continue;
    const coverage = await astV8ToIstanbul({
      code,
      sourceMap: { ...map, sources, sourceRoot: undefined },
      ast: (await parse(path, code)).program,
      coverage: { functions: script.functions, url: pathToFileURL(path).href },
      wrapperLength: 0,
    });
    for (const [file, data] of Object.entries(coverage)) {
      if (files.has(file)) (converted[file] ??= []).push(data);
    }
  }
  return converted;
}

/** @param {import('istanbul-lib-coverage').Location} location */
const position = ({ line, column }) => `${line}:${column}`;

/**
 * @template T, H
 * @param {Record<string, H>} hits
 * @param {Record<string, T>} map
 * @param {Record<string, H>} additionHits
 * @param {Record<string, T>} additionMap
 * @param {(entry: T) => string} keyOf
 * @param {(left: H, right: H) => H} combine
 */
function addHits(hits, map, additionHits, additionMap, keyOf, combine) {
  /** @type {Map<string, string[]>} */
  const targets = new Map();
  for (const [id, entry] of Object.entries(map)) {
    const key = keyOf(entry);
    targets.set(key, [...(targets.get(key) ?? []), id]);
  }
  /** @type {Map<string, number>} */
  const occurrences = new Map();
  for (const [id, entry] of Object.entries(additionMap)) {
    const key = keyOf(entry);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const target = targets.get(key)?.[occurrence];
    if (target !== undefined) hits[target] = combine(hits[target], additionHits[id]);
  }
}

/** @param {number} count */
const evidence = count => Math.max(0, count);

/** @param {number} left @param {number} right */
const sum = (left, right) => left + right;

/** @param {CoverageData} baseline @param {Record<string, FileCoverageData[]>} additions */
export function mergeOntoBaseline(baseline, additions) {
  const merged = structuredClone(baseline);
  for (const [file, coverage] of Object.entries(merged)) {
    for (const id of Object.keys(coverage.s)) coverage.s[id] = evidence(coverage.s[id]);
    for (const id of Object.keys(coverage.f)) coverage.f[id] = evidence(coverage.f[id]);
    for (const id of Object.keys(coverage.b)) coverage.b[id] = coverage.b[id].map(evidence);
    for (const addition of additions[file] ?? []) {
      addHits(
        coverage.s,
        coverage.statementMap,
        addition.s,
        addition.statementMap,
        entry => position(entry.start),
        sum,
      );
      addHits(coverage.f, coverage.fnMap, addition.f, addition.fnMap, entry => position(entry.loc.start), sum);
      addHits(
        coverage.b,
        coverage.branchMap,
        addition.b,
        addition.branchMap,
        entry => `${entry.type}:${position(entry.loc.start)}:${entry.locations.length}`,
        (left, right) => left.map((count, index) => count + right[index]),
      );
    }
  }
  return merged;
}

/** @param {CoverageData} coverage */
export function findIncompleteFiles(coverage) {
  const map = libCoverage.createCoverageMap(coverage);
  return map
    .files()
    .toSorted((left, right) => left.localeCompare(right))
    .flatMap(file => {
      const summary = map.fileCoverageFor(file).toSummary();
      const metrics = /** @type {const} */ (['statements', 'branches', 'functions', 'lines']);
      return metrics.some(metric => summary[metric].pct < 100)
        ? [{ file, ...Object.fromEntries(metrics.map(metric => [metric, summary[metric].pct])) }]
        : [];
    });
}
