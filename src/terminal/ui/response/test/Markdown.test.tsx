import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../Markdown.presentational.tsx';

describe(Markdown, () => {
  it('renders headings, lists, quotes, fenced code, and tables as terminal blocks', () => {
    const view = render(
      <Markdown
        value={`# Markdown Example

Here's a short list:

- **Bold text**
- *Italic text*
- ~~Strikethrough~~
- \`inline code\`
- [A link to OpenAI](https://openai.com)

> Markdown can also create blockquotes.

\`\`\`python
def greet(name):
    return f"Hello, {name}!"
\`\`\`

| Feature | Supported |
| --- | --- |
| Headings | ✅ |
| Tables | ✅ |`}
      />,
    );

    const rendered = stripVTControlCharacters(view.lastFrame() ?? '');
    expect(rendered).toContain('Markdown Example');
    expect(rendered).not.toContain('# Markdown Example');
    expect(rendered).toContain('- Bold text');
    expect(rendered).toContain('- Italic text');
    expect(rendered).toContain('- Strikethrough');
    expect(rendered).toContain('- inline code');
    expect(rendered).toContain('- A link to OpenAI');
    expect(rendered).not.toMatch(/\*\*|~~|\[A link/u);
    expect(rendered).toContain('│ Markdown can also create blockquotes.');
    expect(rendered).toContain('def greet(name):');
    expect(rendered).not.toContain('```python');
    expect(rendered).toContain('┌──────────┬───────────┐');
    expect(rendered).toContain('│ Feature  │ Supported │');
    view.unmount();
  });

  it('renders ordered tasks, rules, line breaks, images, escapes, and HTML without source syntax', () => {
    const view = render(
      <Markdown
        value={`3. [x] Done
4. [ ] Next
5. Plain

---

Escaped \\*star\\*  
next ![diagram](diagram.png) <kbd>K</kbd>

<div>HTML block</div>

[reference]: https://example.com`}
      />,
    );

    const rendered = stripVTControlCharacters(view.lastFrame() ?? '');
    expect(rendered).toContain('[x] Done');
    expect(rendered).toContain('[ ] Next');
    expect(rendered).toContain('5. Plain');
    expect(rendered).toContain('────────────────────────');
    expect(rendered).toContain('Escaped *star*');
    expect(rendered).toContain('next diagram K');
    expect(rendered).toContain('HTML block');
    expect(rendered).not.toContain('<div>');
    expect(rendered).not.toContain('[reference]');
    view.unmount();
  });
});
