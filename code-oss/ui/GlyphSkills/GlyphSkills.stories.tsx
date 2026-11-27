import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn } from 'storybook/test';
import { GlyphSkills } from './GlyphSkills.presentational.tsx';

const meta = {
  title: 'Glyph/Editor/Skills',
  component: GlyphSkills,
  parameters: { paneWidth: '1000' },
  args: {
    edit: fn(),
    skills: [
      {
        id: 'project:review',
        origin: { id: 'project', label: 'Project skill', scope: 'project', compatibility: 'glyph' },
        path: '.glyph/skills/review/SKILL.md',
        directory: '.glyph/skills/review',
        scope: '.',
        name: 'review',
        description: 'Review code changes and report actionable findings backed by evidence.',
        enabled: true,
        status: 'active',
        allowedTools: [],
        uri: 'file:///workspace/.glyph/skills/review/SKILL.md',
        revision: 'c35c7bd91',
      },
      {
        id: 'user:review',
        origin: { id: 'user', label: 'User skill', scope: 'user', compatibility: 'glyph' },
        path: 'skills/review/SKILL.md',
        directory: 'skills/review',
        scope: '.',
        name: 'review',
        description: 'My personal review workflow. Same names retain their separate origins.',
        enabled: false,
        status: 'active',
        allowedTools: [],
        uri: 'file:///home/.glyph/skills/review/SKILL.md',
      },
      {
        id: 'cursor:docs',
        origin: { id: 'cursor', label: 'Cursor-compatible project skill', scope: 'project', compatibility: 'cursor' },
        path: '.cursor/skills/docs/SKILL.md',
        directory: '.cursor/skills/docs',
        scope: 'docs',
        name: 'docs',
        description: '',
        enabled: false,
        status: 'error',
        allowedTools: [],
        uri: 'file:///workspace/.cursor/skills/docs/SKILL.md',
        message: 'Skill metadata is missing a description.',
      },
    ],
  },
} satisfies Meta<typeof GlyphSkills>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Catalog: Story = {};
export const Empty: Story = { args: { skills: [] } };
export const Filtered: Story = { args: { query: 'Project skill' } };
export const NoMatches: Story = { args: { query: 'not found' } };

const management = {
  targets: [
    { id: 'project', label: 'Project skills' },
    { id: 'user', label: 'User skills' },
  ],
  previewDraft: fn(async () => {}),
  installLocal: fn(async () => {}),
  previewRepository: fn(async () => {}),
  setEnabled: fn(async () => {}),
  remove: fn(async () => {}),
  apply: fn(async () => {}),
  discard: fn(async () => {}),
};
export const Manage: Story = { args: { management } };
export const ReviewUpdate: Story = {
  args: {
    management: {
      ...management,
      preview: {
        id: 'preview',
        action: 'update',
        targetId: 'project',
        destination: { label: 'Project skills', scope: 'project' as const, path: '/app/.glyph/skills/review' },
        name: 'review',
        source: 'https://example.test/skills@pinned-commit:review',
        revision: 'a45f094d1e',
        files: [
          {
            path: 'SKILL.md',
            status: 'modified',
            before: 'Review changes.',
            after: 'Review changes and run the targeted tests.',
          },
          { path: 'templates/report.md', status: 'added', after: '# Findings\n\nDescribe actionable issues.' },
        ],
      },
    },
  },
};
export const RefreshNotice: Story = {
  args: {
    management: {
      ...management,
      message: 'The package was changed successfully. Refresh Skills to update the catalog.',
    },
  },
};

export const VisibleControlCharacters: Story = {
  args: {
    management: {
      ...management,
      preview: {
        id: 'controls',
        action: 'install',
        targetId: 'project',
        name: 'review',
        source: 'Local package\u202Efrom disk',
        revision: 'reviewed-bytes',
        destination: { label: 'Project skills', scope: 'project', path: '/app/.glyph/skills/review' },
        files: [{ path: 'report\u202Ejs\n.txt', status: 'added', after: '# مرحبا\nconst value = "\u2066hidden";' }],
      },
    },
  },
};
