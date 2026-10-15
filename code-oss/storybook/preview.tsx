import type { Preview } from '@storybook/preact-vite';
import { stageClassName, frameClassName } from './previewStyles.ts';

const preview: Preview = {
  parameters: { layout: 'fullscreen' },
  initialGlobals: { theme: 'dark', paneWidth: '360' },
  globalTypes: {
    theme: {
      description: 'VS Code preview theme',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'dark', title: 'Dark' },
          { value: 'light', title: 'Light' },
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
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => (
      <div class={`glyph-story-stage ${stageClassName}`} data-theme={context.globals.theme}>
        <div class={`glyph-story-frame ${frameClassName}`} style={{ width: `${context.globals.paneWidth}px` }}>
          <Story />
        </div>
      </div>
    ),
  ],
};

export default preview;
