import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('security: CI supplier authority', () => {
  /**
   * A moving external action tag can change executed code without a repository
   * diff. Check the actual CI workflow's remote actions for immutable commit
   * references. This static policy test never executes supplier code and does
   * not claim that a pinned action or release binary is authenticated or safe.
   */
  it('pins each remote CI action to an immutable commit', async () => {
    const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const references = [...workflow.matchAll(/^\s*-\s*uses:\s+([^\s#]+)/gmu)].map(match => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference).toMatch(/^[\w-]+\/[\w./-]+@[a-f0-9]{40}$/u);
  });

  /** CI verification requires source reads, not repository mutation authority. */
  it('declares read-only contents permission and no write grants', async () => {
    const workflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(workflow).toMatch(/^permissions:\n\s+contents: read$/mu);
    expect(workflow).not.toMatch(/^\s+[\w-]+:\s*write(?:\s|$)/mu);
    expect(workflow).not.toMatch(/permissions:\s*(?:write-all|inherit)/u);
  });
});
