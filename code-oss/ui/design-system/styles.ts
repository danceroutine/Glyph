import createEmotion from '@emotion/css/create-instance';

// Code OSS clones style elements into auxiliary windows and observes text changes.
// CSSOM-only insertion would leave those cloned stylesheets empty in production.
export const { css } = createEmotion({ key: 'glyph', speedy: false });
