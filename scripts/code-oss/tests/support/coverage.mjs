import { resolve } from 'node:path';
import { threadId } from 'node:worker_threads';
import { accumulateBundleCoverage } from '#scripts/coverage/record-coverage.mjs';

const directory = process.env.GLYPH_COMPONENT_COVERAGE_DIR && resolve(process.env.GLYPH_COMPONENT_COVERAGE_DIR);

export const coverageBuildOptions = directory ? { sourcemap: 'inline', sourceRoot: process.cwd() } : {};

export async function newCoveredPage(browser, options) {
  const page = await browser.newPage(options);
  if (!directory) return page;
  await page.coverage.startJSCoverage({ reportAnonymousScripts: true, resetOnNavigation: false });
  const close = page.close.bind(page);
  page.close = async options => {
    if (!page.isClosed())
      await accumulateBundleCoverage(
        directory,
        `components-${process.pid}-${threadId}.json`,
        await page.coverage.stopJSCoverage(),
      );
    return close(options);
  };
  return page;
}
