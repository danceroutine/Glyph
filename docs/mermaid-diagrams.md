# Mermaid diagrams

Flowchart, state, sequence, class, ER, and XY chart diagrams render with
beautiful-mermaid and ELK layout; other diagram types fall back to Mermaid with
Dagre layout. Diagrams render inline and follow the active color theme. A node
named by a Mermaid `click` line opens its link through the same validated path
as Markdown links, from either a click or Enter. Diagrams that fail to render
and oversized diagrams remain inspectable as source. Rendering happens in a
sandboxed frame, and the workbench rebuilds the returned SVG from an allowlist
of elements and attributes inside a shadow root, preserving Code OSS's Trusted
Types policy without introducing a webview.
