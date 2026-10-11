import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending Cursor-style rule contracts. Activation modes are product behavior;
// do not rely on a nondeterministic model answer to prove instruction inclusion.
// Use distinctive fixture rule bodies and inspect recorded provider requests.

it.describe('Pending always-on and conditional agent rules', () => {
  it.fixme(
    'includes enabled always-on rules in every applicable chat turn and identifies their source in the context inspector',
    async () => {},
  );
  it.fixme(
    'attaches a file-pattern rule when matching files enter context through user attachments or agent file reads',
    async () => {},
  );
  it.fixme(
    'does not activate a file-pattern rule for nonmatching files or files outside the rule’s project scope',
    async () => {},
  );
  it.fixme(
    'lets the agent select description-based rules when relevant and shows the selected rules in the turn context',
    async () => {},
  );
  it.fixme(
    'applies manual rules only when the user explicitly mentions them and preserves the selected rule in the outgoing prompt',
    async () => {},
  );
  it.fixme(
    'deduplicates a rule selected by multiple matching files or explicit mentions within the same turn',
    async () => {},
  );
  it.fixme(
    'reevaluates conditional rules for the next turn instead of treating a past match as permanently always-on',
    async () => {},
  );
  it.fixme(
    'keeps rules from separate workspace roots scoped to their own files during a cross-project request',
    async () => {},
  );
  it.fixme('retains always-on guidance and reevaluates conditional guidance after context compaction', async () => {});
});

it.describe('Pending rule configuration and compatibility', () => {
  it.fixme(
    'lets the user create, preview, edit, disable, and remove rules with an explicit activation mode and scope',
    async () => {},
  );
  it.fixme(
    'lets the agent propose rule creation or edits for user review without silently installing persistent instructions',
    async () => {},
  );
  it.fixme(
    'loads compatible .cursor/rules/*.mdc files and respects description, globs, and alwaysApply metadata',
    async () => {},
  );
  it.fixme(
    'reports invalid frontmatter or glob patterns without silently applying the broken rule to every file',
    async () => {},
  );
  it.fixme(
    'shows deterministic user/project/nested-rule precedence and exposes conflicting instructions without inventing hidden overrides',
    async () => {},
  );
  it.fixme(
    'updates future turns after external rule changes while retaining the rule revision used by an in-flight turn',
    async () => {},
  );
  it.fixme(
    'preserves rule configuration and enablement across reload without duplicating imported rules',
    async () => {},
  );
  it.fixme(
    'follows rule file references only within authorized paths and reports missing or circular references',
    async () => {},
  );
  it.fixme('lets the user inspect why a rule did or did not activate and open its source file', async () => {});
  it.fixme(
    'prevents rules from granting tool permissions or overriding explicit user direction and host security policy',
    async () => {},
  );
});
