import type { Preview } from '@storybook/preact-vite';
import { stageClassName, frameClassName } from './previewStyles.ts';

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    options: { storySort: { order: ['Glyph', ['Chat', 'Shared', 'Editor']] } },
  },
  initialGlobals: { theme: 'dark', paneWidth: '360' },
  globalTypes: {
    theme: {
      description: 'VS Code preview theme',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark Modern' },
          { value: 'light', title: 'Light Modern' },
        ],
        dynamicTitle: true,
      },
    },
    paneWidth: {
      description: 'Glyph pane width',
      toolbar: {
        icon: 'sidebar',
        items: [
          { value: '280', title: 'Narrow · 280px' },
          { value: '360', title: 'Sidebar · 360px' },
          { value: '600', title: 'Wide · 600px' },
          { value: '1000', title: 'Editor · 1000px' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div
        class={`glyph-story-stage ${stageClassName}`}
        data-theme={typeof context.globals.theme === 'string' ? context.globals.theme : undefined}
      >
        <div
          class={`glyph-story-frame ${frameClassName}`}
          style={{ '--glyph-preview-width': `${context.globals.paneWidth}px` }}
        >
          <Story />
        </div>
      </div>
    ),
  ],
};

export default preview;
