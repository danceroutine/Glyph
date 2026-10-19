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

it.describe('Pending background shells with agent-configured wake conditions', () => {
  it.fixme(
    'returns control to the agent after starting a background command and shows the live shell and configured wake text',
    async () => {},
  );
  it.fixme(
    'wakes the owning agent when the configured literal text appears in shell output and provides the matching output as context',
    async () => {},
  );
  it.fixme(
    'matches configured wake text across separate output chunks without waking on unrelated output',
    async () => {},
  );
  it.fixme('fires a one-shot wake condition only once even when the matching text appears repeatedly', async () => {});
  it.fixme(
    'lets the agent replace or re-arm the wake condition through shell input and waits for the new text',
    async () => {},
  );
  it.fixme(
    'delivers a wake event while the agent is already working without starting concurrent turns in the same chat',
    async () => {},
  );
  it.fixme(
    'keeps wake events scoped to their owning chat and prevents a closed shell from waking the agent later',
    async () => {},
  );
  it.fixme('shows a background command’s exit or failure even when its wake text never appears', async () => {});
});
