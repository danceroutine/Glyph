import { createRequire } from 'node:module';

// Use the exact Playwright version pinned by the Code OSS checkout, including
// its Electron protocol support, instead of installing a competing root copy.
const upstreamRequire = createRequire(new URL('../../../.code-oss/src/package.json', import.meta.url));
/** @type {(id: '@playwright/test') => typeof import('@playwright/test')} */
const requirePlaywright = upstreamRequire;
const playwright = requirePlaywright('@playwright/test');

export const { test, expect, _electron, defineConfig } = playwright;
