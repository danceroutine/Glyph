import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending skill lifecycle and context contracts. Use disposable SKILL.md packages
// and recorded model requests to prove which instructions actually reach the agent.
// Reading fixture instructions must never execute them in the test runner itself.

it.describe('Pending agent skill discovery and activation', () => {
  it.fixme(
    'discovers valid user and project skills and shows each skill’s name, description, origin, and enabled state',
    async () => {},
  );
  it.fixme(
    'reports malformed SKILL.md metadata and missing entry files without suppressing other valid skills',
    async () => {},
  );
  it.fixme('resolves duplicate skill names visibly and lets the user select the intended scoped skill', async () => {});
  it.fixme(
    'lets the user explicitly invoke an enabled skill from chat and shows which skill was activated',
    async () => {},
  );
  it.fixme('lets the agent select a relevant skill from its description and shows why it was selected', async () => {});
  it.fixme('keeps unrelated or disabled skills out of the active instruction context', async () => {});
  it.fixme(
    'loads skill metadata for discovery and the full instructions only after activation, without eagerly loading every reference',
    async () => {},
  );
  it.fixme(
    'resolves referenced documents, scripts, templates, and assets relative to the selected skill package',
    async () => {},
  );
  it.fixme(
    'combines explicitly selected skills without duplicating their instructions and surfaces conflicts that require user direction',
    async () => {},
  );
  it.fixme(
    'reports missing skill resources or unmet compatibility requirements before claiming that the skill completed',
    async () => {},
  );
});

it.describe('Pending human and agent skill management', () => {
  it.fixme(
    'lets the user preview and install a skill from a local package or selected repository revision into a chosen scope',
    async () => {},
  );
  it.fixme(
    'lets the user create or edit a skill and validates its metadata before making it discoverable',
    async () => {},
  );
  it.fixme(
    'lets the agent propose a skill installation or edit as a reviewable change and applies only the version the user approves',
    async () => {},
  );
  it.fixme(
    'lets the agent draft a new skill from a requested workflow and previews its instructions and bundled files before persistent installation',
    async () => {},
  );
  it.fixme('leaves skills unchanged when an agent-requested installation, edit, or removal is denied', async () => {});
  it.fixme(
    'lets the user enable, disable, update, and uninstall a skill without changing unrelated skills or workspace files',
    async () => {},
  );
  it.fixme(
    'retains the installed skill when an update fails and shows the source and version of the active package',
    async () => {},
  );
  it.fixme(
    'refreshes discovery after external skill-file edits and reload while preserving the user’s enablement choices',
    async () => {},
  );
  it.fixme(
    'preserves the active turn’s skill revision and applies a mid-turn skill update to subsequent activations',
    async () => {},
  );
});

it.describe('Pending skill execution boundaries', () => {
  it.fixme(
    'requires workspace trust and applicable approvals before running bundled scripts or tools requested by a skill',
    async () => {},
  );
  it.fixme(
    'treats skill tool declarations as constraints rather than permission to bypass the user’s grants',
    async () => {},
  );
  it.fixme(
    'rejects package traversal and unauthorized symlink references without exposing files outside the approved skill resources',
    async () => {},
  );
  it.fixme(
    'cancels a skill’s running work with the owning turn and leaves its incomplete steps visible',
    async () => {},
  );
  it.fixme('keeps skill instructions subordinate to explicit user direction and host security policy', async () => {});
  it.fixme(
    'records activated skill provenance so the user can inspect the instructions used for a past response',
    async () => {},
  );
});
