import { createRequire } from 'node:module';

const upstreamRequire = createRequire(new URL('../../../../.code-oss/src/package.json', import.meta.url));
/** @type {(id: '@playwright/test') => typeof import('@playwright/test')} */
const requirePlaywright = upstreamRequire;
const playwright = requirePlaywright('@playwright/test');

export const { chromium, expect } = playwright;
