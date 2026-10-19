import { useMemo } from 'preact/hooks';
import { Marked } from 'marked';
import { GlyphMarkdown } from '#code-oss/ui/GlyphMarkdown/GlyphMarkdown.presentational.tsx';
import { WiredGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagram.wired.tsx';
import { GlyphContextBadge } from '#code-oss/ui/GlyphContextBadge/GlyphContextBadge.presentational.tsx';
import type { GlyphTranscriptState } from './useGlyphTranscriptState.ts';

export function WiredGlyphTranscriptContent({ entry }: { readonly entry: GlyphTranscriptState['entries'][number] }) {
  const { items, prefix } = useMemo(() => {
    const prefix = `GLYPH${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('')}CONTEXT`;
    const expression = new RegExp(`^${prefix}(\\d+)END`);
    const parser = new Marked({
      extensions: [
        {
          name: 'glyph_context',
          level: 'inline',
          start: source => source.indexOf(prefix),
          tokenizer(source) {
            const match = expression.exec(source);
            if (match) return { type: 'glyph_context', raw: match[0], index: Number(match[1]) };
          },
        },
      ],
    });
    return {
      prefix,
      items: parser.lexer(
        entry.parts.map((part, index) => (part.type === 'text' ? part.text : `${prefix}${index}END`)).join(''),
      ),
    };
  }, [entry.text, entry.attachments, entry.options]);
  const badge = (index: number) => {
    const part = entry.parts[index];
    return part?.type === 'attachment' ? (
      <GlyphContextBadge
        label={part.label}
        title={part.title}
        actionLabel="Open"
        onClick={() => entry.openAttachment(part.attachment)}
      />
    ) : null;
  };
  const pattern = new RegExp(`${prefix}(\\d+)END`, 'g');
  const renderText = (value: string) => {
    const fragments = [];
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      fragments.push(value.slice(offset, match.index), badge(Number(match[1])));
      offset = match.index + match[0].length;
    }
    fragments.push(value.slice(offset));
    return fragments;
  };
  return (
    <GlyphMarkdown
      items={items}
      openLink={entry.openLink}
      text={renderText}
      diagram={source => (
        <WiredGlyphDiagram
          source={source.replace(pattern, (_, index) => {
            const part = entry.parts[Number(index)];
            return part?.type === 'attachment' ? part.label : '';
          })}
        />
      )}
      inline={token => ('index' in token ? badge(token.index) : null)}
    />
  );
}
