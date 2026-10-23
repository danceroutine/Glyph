import { resolve } from 'node:path';
import { threadId } from 'node:worker_threads';
import { accumulateBundleCoverage } from '#scripts/coverage/record-coverage.mjs';

const coverageRoot = process.env.GLYPH_COMPONENT_COVERAGE_DIR;
const directory = coverageRoot !== undefined && coverageRoot !== '' ? resolve(coverageRoot) : undefined;

export const coverageBuildOptions =
  directory !== undefined && directory !== '' ? { sourcemap: 'inline', sourceRoot: process.cwd() } : {};

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {import('@playwright/test').BrowserContextOptions} [options]
 */
export async function newCoveredPage(browser, options) {
  const page = await browser.newPage(options);
  if (directory === undefined || directory === '') return page;
  await page.coverage.startJSCoverage({ reportAnonymousScripts: true, resetOnNavigation: false });
  const close = page.close.bind(page);
  page.close = async closeOptions => {
    if (!page.isClosed())
      await accumulateBundleCoverage(
        directory,
        `components-${process.pid}-${threadId}.json`,
        await page.coverage.stopJSCoverage(),
      );
    return close(closeOptions);
  };
  return page;
}
