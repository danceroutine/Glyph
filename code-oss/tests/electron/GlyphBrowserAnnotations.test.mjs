import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending Figma-style comments on integrated-browser pages. Use local fixtures
// with nested elements, scroll containers, frames, shadow roots, and changing
// layouts; exercise pointer and keyboard input through the visible browser UI.
// DOM anchors follow their element; Alt/Option-click anchors use exact document
// coordinates and do not snap to an element. Verify overlays, numbered bubbles,
// and saved comment text through public UI, not internal annotation services.

it.describe('Pending browser annotations — DOM selection and highlighting', () => {
  it.fixme('lets the user enter and leave a visibly indicated browser annotation mode', async () => {});
  it.fixme(
    'highlights the hovered DOM element with an overlay matching its visible bounding box in annotation mode',
    async () => {},
  );
  it.fixme(
    'moves the highlight to the element under the pointer, including nested children, and clears the previous highlight',
    async () => {},
  );
  it.fixme(
    'updates the hovered bounding box after page scrolling, nested-container scrolling, resizing, or browser zoom',
    async () => {},
  );
  it.fixme(
    'clicks a highlighted element to open a comment composer anchored to that element without activating its page action',
    async () => {},
  );
  it.fixme(
    'selects an element inside a supported iframe or shadow root with its highlight aligned to the embedded content',
    async () => {},
  );
  it.fixme(
    'indicates unsupported embedded content without highlighting or annotating an unrelated element',
    async () => {},
  );
  it.fixme(
    'clears the hover highlight and cancels an unsubmitted selection with Escape without creating a comment',
    async () => {},
  );
  it.fixme('excludes annotation overlays, bubbles, and composers from page-element hit testing', async () => {});
});

it.describe('Pending browser annotations — Alt/Option-click exact positioning', () => {
  it.fixme(
    'uses Alt-click on Windows and Linux or Option-click on macOS in annotation mode to place a comment at the exact pointer position',
    async () => {},
  );
  it.fixme(
    'places a position annotation over an element without snapping to its bounding box or creating a second DOM annotation',
    async () => {},
  );
  it.fixme('places a position annotation in empty page space without requiring an element target', async () => {});
  it.fixme(
    'translates a modified click into the correct document position after scrolling, browser zoom, and display scaling',
    async () => {},
  );
  it.fixme(
    'consumes an annotation Alt/Option-click on a link or control without navigating, downloading, or activating the control',
    async () => {},
  );
  it.fixme('returns to DOM-element selection for the next ordinary click after Alt/Option is released', async () => {});
});

it.describe('Pending browser annotations — numbered comment bubbles and editing', () => {
  it.fixme(
    'saves a DOM or position comment as a small numbered bubble at its anchor and closes the composer',
    async () => {},
  );
  it.fixme(
    'assigns distinct sequential numbers to new comments on the page and keeps their numbers stable when reopened or edited',
    async () => {},
  );
  it.fixme('clicks a numbered bubble to expand its saved comment at the associated anchor', async () => {});
  it.fixme('collapses an expanded comment without deleting its numbered bubble or saved text', async () => {});
  it.fixme(
    'lets the user reopen a comment, edit its text, and save changes without creating another bubble or changing its anchor',
    async () => {},
  );
  it.fixme('cancels a comment edit and restores the previously saved text and number', async () => {});
  it.fixme('cancels a new comment draft without leaving an empty bubble', async () => {});
  it.fixme(
    'rejects an empty or whitespace-only comment while leaving its composer available for correction',
    async () => {},
  );
  it.fixme('preserves multiline and Unicode comments and renders markup as literal comment text', async () => {});
  it.fixme(
    'lets the user select each of several nearby or overlapping comment bubbles and expands the matching comment',
    async () => {},
  );
  it.fixme(
    'keeps an expanded comment and its edit controls within reach when its anchor is near a browser viewport edge',
    async () => {},
  );
  it.fixme(
    'lets the user focus numbered bubbles by keyboard, expand and edit a comment, and dismiss it with focus returned to its bubble',
    async () => {},
  );
});

it.describe('Pending browser annotations — anchors, page isolation, and restoration', () => {
  it.fixme(
    'keeps a DOM comment bubble attached to its selected element when the page layout moves or resizes that element',
    async () => {},
  );
  it.fixme('keeps a position comment at its saved document coordinates when nearby DOM elements move', async () => {});
  it.fixme(
    'moves and clips comment bubbles with their anchors during page or nested-container scrolling and browser zoom',
    async () => {},
  );
  it.fixme(
    'marks a missing or ambiguous DOM anchor as unresolved while keeping its comment accessible without attaching it to another element',
    async () => {},
  );
  it.fixme(
    'switches visible comments with the selected browser page without showing another page’s bubbles or text',
    async () => {},
  );
  it.fixme(
    'hides the previous page’s annotations after navigation, including client-side route changes, and restores them on returning to that page',
    async () => {},
  );
  it.fixme(
    'restores saved comments, numbers, and anchor types after a page reload and marks anchors that can no longer be resolved',
    async () => {},
  );
  it.fixme(
    'restores saved browser annotations after a Glyph window reload without duplicating bubbles or losing edited text',
    async () => {},
  );
});
