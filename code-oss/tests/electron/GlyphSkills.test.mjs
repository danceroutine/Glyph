import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';
import { z } from 'zod';

// Pending skill lifecycle and context contracts. Use disposable SKILL.md packages
// and recorded model requests to prove which instructions actually reach the agent.
// Reading fixture instructions must never execute them in the test runner itself.

const skillFiles = {
  '.glyph/skills/example/SKILL.md':
    '---\nname: example\ndescription: Use for UI fixture examples\n---\nEXAMPLE SKILL BODY',
  '.glyph/skills/example/references/notes.md': 'REFERENCE SKILL BODY',
  '.glyph/skills/example/scripts/read-only.sh': 'echo DO_NOT_EXECUTE_SKILL_FIXTURE',
  '.glyph/skills/bad/SKILL.md': 'Malformed metadata',
  '.glyph/skills/missing/resource.md': 'Missing manifest',
};
const candidateSchema = z.object({ id: z.string(), name: z.string(), origin: z.object({ scope: z.string() }) });
const contextSchema = z.object({
  schema: z.literal('glyph.agent-instructions.v1'),
  skillCandidates: z.array(candidateSchema).optional(),
});
/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */
/** @typedef {import('./ScriptedProvider.mjs').ScriptedProvider} ScriptedProvider */

it.describe('Agent skill discovery and activation', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true, workspaceFiles: skillFiles });
  it.fixme(
    'discovers valid user and project skills and shows each skill’s name, description, origin, and enabled state',
    async () => {},
  );
  it('reports malformed SKILL.md metadata and missing entry files without suppressing other valid skills', async ({
    glyph,
    provider,
  }) => {
    await sendSkillText(glyph, provider, 'Refresh skill metadata.');
    await glyph.page.getByRole('button', { name: 'Chat actions' }).click();
    await glyph.page.getByRole('menuitem', { name: 'Agent Settings' }).click();
    await glyph.page.getByText('Skills', { exact: true }).click();
    const page = glyph.page.getByRole('region', { name: 'Skills' });
    await expect(page).toContainText('Use for UI fixture examples');
    await expect(page).toContainText('bad');
    await expect(page).toContainText('missing');
    await expect(page.getByRole('listitem').filter({ hasText: 'bad' }).getByRole('status')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'missing' }).getByRole('status')).toBeVisible();
    await expect(page.getByRole('button', { name: /Edit example/u })).toBeVisible();
    await page.getByRole('button', { name: /Edit example/u }).click();
    await expect(glyph.page.getByRole('tab', { name: /SKILL.md/u }).first()).toBeVisible();
    const close = glyph.page.getByRole('button', { name: /Close Modal Editor/u });
    if (await close.isVisible()) await close.click();
  });
  it.fixme('resolves duplicate skill names visibly and lets the user select the intended scoped skill', async () => {});
  it('lets the user explicitly invoke an enabled skill from chat and shows which skill was activated', async ({
    glyph,
    provider,
  }) => {
    await glyph.composer.fill('/example');
    const option = glyph.page
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: 'Use for UI fixture examples' })
      .first();
    await expect(option).toBeVisible();
    await option.click();
    const start = provider.requests.length;
    provider.enqueue({ chunks: ['Manual skill activated.'] });
    await glyph.sendButton.click();
    await expect.poll(() => provider.requests.length).toBe(start + 1);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    expect(JSON.stringify(provider.requests[start].body.input)).toContain('EXAMPLE SKILL BODY');
    await expect(glyph.page.locator('summary').filter({ hasText: 'Context used' }).last()).toBeVisible();
  });

  it('lets the agent select a relevant skill from its description and shows why it was selected', async ({
    glyph,
    provider,
  }) => {
    const request = await sendSkillText(glyph, provider, 'Show available skills.');
    const candidate = skillCandidate(request);
    const start = provider.requests.length;
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool(
            'activate',
            { id: candidate.id, reason: 'This task needs the fixture workflow' },
            { namespace: 'skills', callId: 'activate-skill' },
          ),
        ],
      },
      { chunks: ['Activated.'] },
    );
    await glyph.send('Choose the example workflow.');
    await expect.poll(() => provider.requests.length).toBe(start + 2);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    expect(JSON.stringify(provider.requests[start].body.input)).not.toContain('EXAMPLE SKILL BODY');
    expect(JSON.stringify(provider.requests[start + 1].body.input)).toContain('EXAMPLE SKILL BODY');
    const inspector = glyph.page
      .locator('details')
      .filter({ has: glyph.page.locator('summary').filter({ hasText: 'Context used' }) })
      .last();
    await inspector.locator('summary').first().click();
    await expect(inspector).toContainText('This task needs the fixture workflow');
  });
  it.fixme('keeps unrelated or disabled skills out of the active instruction context', async () => {});
  it('loads skill metadata for discovery and the full instructions only after activation, without eagerly loading every reference', async ({
    glyph,
    provider,
  }) => {
    const request = await sendSkillText(glyph, provider, 'Refresh the skill catalog.');
    const candidate = skillCandidate(request);
    const start = provider.requests.length;
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool(
            'activate',
            { id: candidate.id, reason: 'Use the example workflow' },
            { namespace: 'skills', callId: 'progressive-activate' },
          ),
        ],
      },
      {
        output: [
          ScriptedProvider.tool(
            'read_resource',
            { id: candidate.id, path: 'references/notes.md' },
            { namespace: 'skills', callId: 'progressive-resource' },
          ),
        ],
      },
      { chunks: ['Loaded the requested reference.'] },
    );
    await glyph.send('Read the skill reference when needed.');
    await expect.poll(() => provider.requests.length).toBe(start + 3);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    expect(JSON.stringify(provider.requests[start].body.input)).not.toContain('EXAMPLE SKILL BODY');
    expect(JSON.stringify(provider.requests[start + 1].body.input)).toContain('EXAMPLE SKILL BODY');
    expect(JSON.stringify(provider.requests[start + 1].body.input)).not.toContain('REFERENCE SKILL BODY');
    expect(JSON.stringify(provider.requests[start + 2].body.input)).toContain('REFERENCE SKILL BODY');
    expect(JSON.stringify(provider.requests[start + 2].body.input)).not.toContain('DO_NOT_EXECUTE_SKILL_FIXTURE');
    const next = await sendSkillText(glyph, provider, 'An unrelated following turn.');
    expect(JSON.stringify(next.body.input)).not.toContain('EXAMPLE SKILL BODY');
    expect(JSON.stringify(next.body.input)).not.toContain('REFERENCE SKILL BODY');
  });
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

/** @param {GlyphWorkbench} glyph @param {ScriptedProvider} provider @param {string} prompt */
async function sendSkillText(glyph, provider, prompt) {
  const start = provider.requests.length;
  provider.enqueue({ chunks: ['Ready.'] });
  await glyph.send(prompt);
  await expect.poll(() => provider.requests.length).toBe(start + 1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const request = provider.requests[start];
  if (!request) throw new Error('Missing scripted request.');
  return request;
}
/** @param {ScriptedProvider['requests'][number]} request */
function skillCandidate(request) {
  for (const item of request.body.input) {
    if (typeof item.content !== 'string') continue;
    let value;
    try {
      value = contextSchema.safeParse(JSON.parse(item.content));
    } catch {
      continue;
    }
    if (!value.success) continue;
    const candidate = value.data.skillCandidates?.find(
      skill => skill.name === 'example' && skill.origin.scope === 'project',
    );
    if (candidate) return candidate;
  }
  throw new Error('Missing example skill candidate.');
}
