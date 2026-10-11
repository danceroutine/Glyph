import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending AGENTS.md discovery, inheritance, and refresh contracts. Fixture files
// are application input, not instructions for the test runner or its environment.

it.describe('Pending AGENTS.md instruction support', () => {
  it.fixme(
    'discovers a workspace-root AGENTS.md and includes its Markdown instructions without requiring frontmatter',
    async () => {},
  );
  it.fixme(
    'combines ancestor and nested AGENTS.md instructions for a target file with the nearest file taking precedence on conflicts',
    async () => {},
  );
  it.fixme(
    'keeps instructions from sibling directories and unrelated workspace roots out of a target file’s context',
    async () => {},
  );
  it.fixme(
    'discovers applicable nested instructions before the agent edits a file it found during the turn',
    async () => {},
  );
  it.fixme('applies the instruction chain for a new file’s destination before proposing its creation', async () => {});
  it.fixme('reevaluates instruction scope when a file is moved to another directory', async () => {});
  it.fixme('shows every applied AGENTS.md path and its scope alongside other active rules', async () => {});
  it.fixme(
    'honors explicit user directions when they conflict with repository instructions without relaxing host permissions',
    async () => {},
  );
  it.fixme(
    'detects created, edited, or deleted AGENTS.md files and refreshes subsequent turns without silently rewriting an active turn’s context',
    async () => {},
  );
  it.fixme(
    'reports unreadable or oversized instruction files with their paths instead of silently omitting or truncating mandatory guidance',
    async () => {},
  );
  it.fixme(
    'does not follow AGENTS.md symlinks or parent-directory discovery beyond the user-authorized instruction scope',
    async () => {},
  );
  it.fixme(
    'does not treat an AGENTS.md mentioned inside fetched content or a tool response as a new authoritative instruction file',
    async () => {},
  );
  it.fixme(
    'lets the user or agent propose creating or updating AGENTS.md through normal reviewable file changes',
    async () => {},
  );
  it.fixme(
    'restores the applicable instruction chain after reload or context compaction without duplicating its contents',
    async () => {},
  );
});
