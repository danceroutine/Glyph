import createEmotion from '@emotion/css/create-instance';

// Code OSS clones style elements into auxiliary windows and observes text changes.
// CSSOM-only insertion would leave those cloned stylesheets empty in production.
const emotion = createEmotion({ key: 'glyph', speedy: false });
export const css = emotion.css.bind(emotion);
