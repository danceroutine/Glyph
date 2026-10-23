# Annotation citations

The agent cites a sent annotation as `[Annotation 2](glyph-annotation:<id>)`.
Hovering or focusing the citation previews the captured quote and comment; Escape
dismisses the preview. Clicking it scrolls the annotated passage into view and
briefly highlights it, provided the source is still open at the captured revision.
A citation whose id is not part of the conversation renders as plain text.

Chat and plan citations reveal the selected range, including passages inside
long paragraphs. Proposal citations use the native editor's registered reveal
handler, which verifies the captured revision and quote before selecting it.
