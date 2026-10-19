import type { Meta, StoryObj } from '@storybook/preact-vite';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { agentMessageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import { progressFixture } from '#code-oss/storybook/fixtures/ToolFixtures.ts';
import { agentMessageDecorators } from '#code-oss/storybook/decorators.tsx';
import {
  GlyphToolActivityStatus as Status,
  type GlyphToolActivity,
} from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { WiredGlyphAgentMessage } from './GlyphAgentMessage.wired.tsx';

const search: GlyphToolActivity = {
  id: 'search',
  name: 'web_search',
  status: Status.COMPLETED,
  textOffset: 0,
  arguments: JSON.stringify({ query: 'largest octopus species' }),
  summary: JSON.stringify({
    kind: 'web_search',
    query: 'largest octopus species',
    searchUrl: 'https://duckduckgo.com/?q=largest+octopus+species',
    provenance: 'search_snippets_only',
    results: [
      {
        title: 'Giant Pacific octopus',
        url: 'https://en.wikipedia.org/wiki/Giant_Pacific_octopus',
        snippet: 'The giant Pacific octopus is a large marine cephalopod.',
      },
      {
        title: 'Octopus facts',
        url: 'https://ocean.si.edu/ocean-life/invertebrates/octopuses',
        snippet: 'Learn about octopus anatomy and life in the ocean.',
      },
    ],
  }),
};
const fetched: GlyphToolActivity = {
  id: 'fetch',
  name: 'web_fetch',
  status: Status.COMPLETED,
  textOffset: 0,
  arguments: JSON.stringify({ url: 'https://en.wikipedia.org/wiki/Giant_Pacific_octopus' }),
  summary: JSON.stringify({
    kind: 'web_fetch',
    source: { title: 'Giant Pacific octopus', url: 'https://en.wikipedia.org/wiki/Giant_Pacific_octopus' },
    contentType: 'text/html',
    content: 'The giant Pacific octopus is a large marine cephalopod.',
    truncated: false,
    provenance: 'untrusted_web_content',
  }),
};
const meta = {
  title: 'Glyph/Chat/In Transcript/Agent Message/Tool calls/Web',
  component: WiredGlyphAgentMessage,
  decorators: agentMessageDecorators,
  globals: { paneWidth: '600' },
  args: {
    chatId: 'chat',
    actions: previewActionsFixture(),
    entry: agentMessageFixture({
      text: 'I searched the web and fetched a source. The giant Pacific octopus is one of the largest octopus species.',
      progress: progressFixture({ reasoning: '', status: GlyphRunStatus.COMPLETED, tools: [search, fetched] }),
    }),
  },
} satisfies Meta<typeof WiredGlyphAgentMessage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SearchAndFetch: Story = {};
export const SearchResults: Story = {
  args: {
    entry: agentMessageFixture({
      text: 'Here are the search results.',
      progress: progressFixture({ reasoning: '', status: GlyphRunStatus.COMPLETED, tools: [search] }),
    }),
  },
};
export const ExpandedResults: Story = {
  ...SearchResults,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLElement>('[data-tool-id="search"] summary')?.click();
  },
};
export const Fetch: Story = {
  args: {
    entry: agentMessageFixture({
      text: 'I fetched the source.',
      progress: progressFixture({ reasoning: '', status: GlyphRunStatus.COMPLETED, tools: [fetched] }),
    }),
  },
};
export const Searching: Story = {
  args: {
    entry: agentMessageFixture({
      text: '',
      progress: progressFixture({
        reasoning: '',
        status: GlyphRunStatus.STREAMING,
        tools: [{ ...search, status: Status.STARTED, summary: '' }],
      }),
    }),
  },
};
export const NoResults: Story = {
  args: {
    entry: agentMessageFixture({
      text: 'No matching sources were found.',
      progress: progressFixture({
        reasoning: '',
        status: GlyphRunStatus.COMPLETED,
        tools: [{ ...search, summary: JSON.stringify({ ...JSON.parse(search.summary!), results: [] }) }],
      }),
    }),
  },
};
export const Failed: Story = {
  args: {
    entry: agentMessageFixture({
      text: 'The search provider is unavailable.',
      progress: progressFixture({
        reasoning: '',
        status: GlyphRunStatus.COMPLETED,
        tools: [
          {
            ...search,
            status: Status.FAILED,
            summary: JSON.stringify({
              kind: 'web_error',
              source: { title: 'Web search results', url: 'https://duckduckgo.com/?q=largest+octopus+species' },
              error: {
                code: 'SEARCH_UNAVAILABLE',
                message:
                  'DuckDuckGo requested a browser verification. Open the search in your browser or try again later.',
              },
            }),
          },
        ],
      }),
    }),
  },
};
export const Interrupted: Story = {
  args: {
    entry: agentMessageFixture({
      text: '',
      progress: progressFixture({
        reasoning: '',
        status: GlyphRunStatus.COMPLETED,
        tools: [{ ...fetched, status: Status.INTERRUPTED, summary: '' }],
      }),
    }),
  },
};
export const Narrow: Story = { ...SearchAndFetch, globals: { paneWidth: '280' } };
