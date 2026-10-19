import { test as it } from './GlyphWorkbench.fixture.mjs';

// Product contracts, not evidence that these capabilities are implemented.
// Enable each through public workbench controls with deterministic provider,
// local HTTP, or disposable shell fixtures as appropriate; no live accounts.

// Plan Mode contracts are exercised in GlyphPlansAnnotations.test.mjs.

it.describe('Pending blocking sub-agents', () => {
  it.fixme('shows a delegated task and its running sub-agent while the parent waits for the result', async () => {});
  it.fixme(
    'returns the completed sub-agent result to the waiting parent exactly once and lets the parent continue',
    async () => {},
  );
  it.fixme(
    'reports a sub-agent failure to the waiting parent without leaving either run stuck in a waiting state',
    async () => {},
  );
  it.fixme(
    'cancels a blocking sub-agent with its parent and prevents late results from restarting the cancelled turn',
    async () => {},
  );
});

it.describe('Pending background sub-agents', () => {
  it.fixme(
    'starts a visible background sub-agent while the parent continues working without waiting for completion',
    async () => {},
  );
  it.fixme(
    'keeps concurrent sub-agent tasks and progress distinct and attributes each result to its originating task',
    async () => {},
  );
  it.fixme(
    'delivers a background sub-agent completion to its owning conversation exactly once without duplicating a parent turn',
    async () => {},
  );
  it.fixme(
    'lets the user stop one background sub-agent without cancelling its siblings or losing their results',
    async () => {},
  );
  it.fixme(
    'prevents a sub-agent from gaining workspace or tool permissions that its parent was not granted',
    async () => {},
  );
});

// Web Fetch and Web Search contracts run in GlyphWeb.test.mjs.

// Background shell wake and termination contracts run in GlyphBackgroundShells.test.mjs.
