import { describe, expect, it } from 'vitest';
import { ProjectAgentInstructions } from '../ProjectAgentInstructions.ts';

describe(ProjectAgentInstructions, () => {
  describe(ProjectAgentInstructions.prototype.render, () => {
    it('keeps identity, discovery, editing, and completion rules in explicit sections', () => {
      const instructions = new ProjectAgentInstructions('You are a careful software engineer.').render();

      expect(instructions).toContain('# Identity\n\nYou are a careful software engineer.');
      expect(instructions).toContain('## Project discovery');
      expect(instructions).toContain('## Editing workflow');
      expect(instructions).toContain('## Attached workspace context');
      expect(instructions).toContain('glyph.workspace-context.v1');
      expect(instructions).toContain('project.propose_patch');
      expect(instructions).toContain('never claim that the files have already changed');
    });
  });
});
