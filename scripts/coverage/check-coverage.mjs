import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProcessCoverage } from './record-coverage.mjs';
import { convertProcessCoverage, findIncompleteFiles, mergeOntoBaseline } from './v8-coverage.mjs';
import { coverageSchema } from './coverage-schema.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const reportDirectory = join(repositoryRoot, 'coverage', 'merged');
const baseline = coverageSchema.parse(
  JSON.parse(await readFile(join(repositoryRoot, 'coverage', 'vitest', 'coverage-final.json'), 'utf8')),
);
const directories = process.argv.slice(2);
if (directories.length === 0) throw new Error('Pass the coverage directories to merge explicitly.');
const processes = (
  await Promise.all(directories.map(directory => readProcessCoverage(resolve(repositoryRoot, directory))))
).flat();
const additions = await convertProcessCoverage(processes, { repositoryRoot, files: new Set(Object.keys(baseline)) });
const merged = mergeOntoBaseline(baseline, additions);

await rm(reportDirectory, { recursive: true, force: true });
await mkdir(reportDirectory, { recursive: true });
await writeFile(join(reportDirectory, 'coverage-final.json'), JSON.stringify(merged));
const context = libReport.createContext({ dir: reportDirectory, coverageMap: libCoverage.createCoverageMap(merged) });
reports.create('html').execute(context);
reports.create('json-summary').execute(context);
reports.create('text', { skipFull: true }).execute(context);
reports.create('text-summary').execute(context);

const incomplete = findIncompleteFiles(merged);
if (incomplete.length > 0) {
  process.stderr.write(`${incomplete.length} of ${Object.keys(merged).length} files are below 100% coverage.\n`);
  process.exitCode = 1;
}
