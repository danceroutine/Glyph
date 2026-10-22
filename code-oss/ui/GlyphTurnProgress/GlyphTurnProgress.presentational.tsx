import {
  GlyphWebActivity,
  isWebTool,
  webToolName,
  webActivityResult,
} from '#code-oss/ui/GlyphWebActivity/GlyphWebActivity.tsx';
import { WebToolName } from '#src/web/WebToolName.js';
import { GlyphToolDisclosure } from './GlyphToolDisclosure.tsx';
import { GlyphToolIcon } from './GlyphToolIcon.tsx';
import type { GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus, type GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    color: tokens.text.muted,
    fontSize: tokens.font.size.body,
    lineHeight: 1.6,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    padding: '0 10px',
  }),
  reasoning: css({ marginBottom: 12, '& p': { whiteSpace: 'pre-wrap' } }),
  tools: css({ padding: 0, margin: '6px 0 12px', listStyle: 'none', '& > li': { margin: '4px 0', minWidth: 0 } }),
  group: css({ margin: '8px 0 12px' }),
  body: css({
    margin: '6px 0 8px',
    border: tokens.border.default,
    borderRadius: 8,
    padding: '8px 10px',
    fontFamily: tokens.font.family.code,
    fontSize: tokens.font.size.body,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: 320,
    overflowY: 'auto',
    userSelect: 'text',
  }),
  status: css({
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  }),
};

function format(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
function toToolLabel(status: GlyphToolActivityStatus, active: boolean): string {
  switch (status) {
    case GlyphToolActivityStatus.STARTED:
      return active ? 'Running' : 'Interrupted';
    case GlyphToolActivityStatus.COMPLETED:
      return 'Finished';
    case GlyphToolActivityStatus.FAILED:
      return 'Failed';
    case GlyphToolActivityStatus.INTERRUPTED:
      return 'Interrupted';
  }
}
function ToolRow({ tool, active }: { readonly tool: GlyphToolActivity; readonly active: boolean }) {
  const status = toToolLabel(tool.status, active);
  const running = status === 'Running';
  const rawLabel = `${running ? 'Running ' : status === 'Failed' ? 'Run attempted · ' : status === 'Interrupted' ? 'Interrupted · ' : ''}${tool.name.replaceAll('_', ' ')}`;
  const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1);
  return (
    <li aria-busy={running} data-tool-id={tool.id}>
      <GlyphToolDisclosure label={label} icon={<GlyphToolIcon />} running={running}>
        <pre class={styles.body}>
          {[tool.arguments, tool.summary]
            .filter((value): value is string => value !== undefined && value !== '')
            .map(value => format(value))
            .filter(Boolean)
            .join('\n\n') || (running ? 'Waiting for the result…' : 'No details recorded for this call.')}
        </pre>
        <div class={`glyph-tool-status ${styles.status}`}>{status}</div>
      </GlyphToolDisclosure>
    </li>
  );
}
function ToolGroup({
  tools,
  active,
  openLink,
}: {
  readonly tools: readonly GlyphToolActivity[];
  readonly active: boolean;
  readonly openLink?: ((href: string) => void) | undefined;
}) {
  const running = active && tools.some(tool => tool.status === GlyphToolActivityStatus.STARTED);
  const failures = tools.filter(
    tool =>
      tool.status === GlyphToolActivityStatus.FAILED ||
      (isWebTool(tool) && webActivityResult(tool)?.kind === 'web_error'),
  ).length;
  const interrupted = tools.some(
    tool =>
      tool.status === GlyphToolActivityStatus.INTERRUPTED ||
      (!active && tool.status === GlyphToolActivityStatus.STARTED),
  );
  const list = (
    <ul class={`glyph-tools ${styles.tools}`} aria-label="Tool activity">
      {tools.map(tool =>
        isWebTool(tool) ? (
          <GlyphWebActivity key={tool.id} tool={tool} active={active} openLink={openLink} />
        ) : (
          <ToolRow key={tool.id} tool={tool} active={active} />
        ),
      )}
    </ul>
  );
  return tools.length === 1 ? (
    list
  ) : (
    <GlyphToolDisclosure
      class={`glyph-tool-group ${styles.group}`}
      prefix={running ? 'Exploring' : 'Explored'}
      icon={<GlyphToolIcon web={tools.every(value => isWebTool(value))} />}
      running={running}
      label={
        [
          [tools.filter(tool => webToolName(tool) === WebToolName.SEARCH).length, 'search', 'searches'],
          [tools.filter(tool => webToolName(tool) === WebToolName.FETCH).length, 'fetch', 'fetches'],
          [tools.filter(tool => !isWebTool(tool)).length, 'tool', 'tools'],
        ]
          .filter(([count]) => Number(count) > 0)
          .map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`)
          .join(', ') + (failures ? ` · ${failures} failed` : interrupted ? ' · interrupted' : '')
      }
    >
      {list}
    </GlyphToolDisclosure>
  );
}
export function GlyphTurnProgress({
  progress,
  openLink,
}: {
  readonly progress: NonNullable<GlyphTranscriptEntry['progress']>;
  readonly openLink?: ((href: string) => void) | undefined;
}) {
  const active = [
    GlyphRunStatus.STREAMING,
    GlyphRunStatus.WAITING_FOR_QUESTION,
    GlyphRunStatus.WAITING_FOR_APPROVAL,
  ].includes(progress.status);
  const groups: GlyphToolActivity[][] = [];
  for (const tool of progress.tools) {
    const previous = groups.at(-1);
    if (previous && previous[0]!.textOffset === tool.textOffset) previous.push(tool);
    else groups.push([tool]);
  }
  return (
    <section class={`glyph-turn-progress ${styles.root}`} aria-label="Turn progress">
      {progress.reasoning && (
        <GlyphToolDisclosure class={`glyph-reasoning ${styles.reasoning}`} label="Reasoning summary">
          <p>{progress.reasoning}</p>
        </GlyphToolDisclosure>
      )}
      {groups.map(tools => (
        <ToolGroup key={tools[0]!.id} tools={tools} active={active} openLink={openLink} />
      ))}
    </section>
  );
}
