import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending user-facing integrated-browser contracts. Open links through public
// workbench controls and serve deterministic local pages, redirects, and errors.
// Verify the rendered page and browser controls inside the actual Glyph window.
// Agent-driven CDP tool contracts live separately in GlyphBrowserAutomation.

it.describe('Pending integrated browser — opening links in Glyph', () => {
  it.fixme('opens an HTTP or HTTPS link from a chat response in an integrated browser inside Glyph', async () => {});
  it.fixme('opens web links from editor text and rendered Markdown previews in the integrated browser', async () => {});
  it.fixme('opens a localhost development-server link from terminal output in the integrated browser', async () => {});
  it.fixme(
    'preserves the chat selection and unsent composer draft when opening a link and returning to chat',
    async () => {},
  );
  it.fixme(
    'keeps workspace file and line links opening in the code editor when web links use the integrated browser',
    async () => {},
  );
  it.fixme(
    'keeps clicked page links and user-initiated target-blank links inside Glyph without launching the system browser',
    async () => {},
  );
});

it.describe('Pending integrated browser — navigation and lifecycle', () => {
  it.fixme(
    'lets the user enter a URL and shows the current page title and final address after redirects',
    async () => {},
  );
  it.fixme(
    'navigates backward and forward through page history and disables unavailable history actions',
    async () => {},
  );
  it.fixme('reloads the selected page and displays its updated content', async () => {});
  it.fixme(
    'shows loading progress and lets the user stop a pending navigation while keeping browser controls usable',
    async () => {},
  );
  it.fixme(
    'shows a failed navigation with its requested address and lets the user retry or enter another URL',
    async () => {},
  );
  it.fixme(
    'lets the user switch between open browser pages with independent addresses and navigation histories',
    async () => {},
  );
  it.fixme('closes a browser page without closing its neighboring pages or the owning chat', async () => {});
  it.fixme('supports normal page clicks, text entry, and scrolling while annotation mode is off', async () => {});
});
