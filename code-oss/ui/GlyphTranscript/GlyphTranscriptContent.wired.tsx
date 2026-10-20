import { WiredGlyphCodeBlock } from '#code-oss/ui/GlyphCodeBlock/GlyphCodeBlock.wired.tsx';
import { useMemo } from 'preact/hooks';
import { Marked } from 'marked';
import { GlyphMarkdown, type GlyphContextToken } from '#code-oss/ui/GlyphMarkdown/GlyphMarkdown.presentational.tsx';
import { WiredGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagram.wired.tsx';
import { GlyphContextBadge } from '#code-oss/ui/GlyphContextBadge/GlyphContextBadge.presentational.tsx';
import type { GlyphMessageState } from '#code-oss/ui/GlyphAgentMessage/useGlyphMessageState.ts';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { WiredGlyphAnnotationCitation } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotationCitation.wired.tsx';

const annotationScheme = 'glyph-annotation:';

export function WiredGlyphTranscriptContent({ entry }: { readonly entry: GlyphMessageState['entries'][number] }) {
  const { items, prefix } = useMemo(() => {
    const prefix = `GLYPH${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('')}CONTEXT`;
    const expression = new RegExp(`^${prefix}(\\d+)END`, 'u');
    const parser = new Marked({
      extensions: [
        {
          name: 'glyph_context',
          level: 'inline',
          start: source => source.indexOf(prefix),
          tokenizer(source) {
            const match = expression.exec(source);
            if (match)
              return { type: 'glyph_context', raw: match[0], index: Number(match[1]) } satisfies GlyphContextToken;
            return undefined;
          },
        },
      ],
    });
    return {
      prefix,
      items: parser.lexer(
        entry.parts
          .map((part, index) =>
            part.type === 'text'
              ? entry.role === GlyphTranscriptRole.ASSISTANT &&
                entry.options?.agentReviewId !== undefined &&
                entry.options?.agentReviewId !== ''
                ? part.text.replaceAll(/<glyph_review>[\s\S]*?(?:<\/glyph_review>|$)/gu, '')
                : part.text
              : `${prefix}${index}END`,
          )
          .join(''),
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
        onClick={() => {
          entry.openAttachment(part.attachment);
        }}
      />
    ) : null;
  };
  const pattern = new RegExp(`${prefix}(\\d+)END`, 'gu');
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
      code={(source, language) => (
        <WiredGlyphCodeBlock
          copyText={entry.copyText}
          language={language}
          source={source.replace(pattern, (_, index) => {
            const part = entry.parts[Number(index)];
            return part?.type === 'attachment'
              ? `@${part.attachment.path}${part.attachment.range ? ` (${part.attachment.range.start.line}-${part.attachment.range.end.line})` : ''}`
              : '';
          })}
        />
      )}
      diagram={source => (
        <WiredGlyphDiagram
          openLink={entry.openLink}
          source={source.replace(pattern, (_, index) => {
            const part = entry.parts[Number(index)];
            return part?.type === 'attachment' ? part.label : '';
          })}
        />
      )}
      inline={token => badge(token.index)}
      link={(token, children) => {
        if (!token.href.startsWith(annotationScheme)) return undefined;
        const annotation = entry.annotation(token.href.slice(annotationScheme.length));
        return annotation ? (
          <WiredGlyphAnnotationCitation annotation={annotation}>{children}</WiredGlyphAnnotationCitation>
        ) : (
          <span>{children}</span>
        );
      }}
    />
  );
}
