import { ChevronRight, Wrench } from 'lucide-preact';
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
  summary: css({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: 'fit-content',
    maxWidth: '100%',
    minHeight: 26,
    cursor: 'pointer',
    listStyle: 'none',
    userSelect: 'none',
    '&::-webkit-details-marker': { display: 'none' },
    '& > .glyph-tool-chevron': {
      opacity: 0,
      flexShrink: 0,
      color: tokens.text.muted,
      transition: 'opacity 100ms ease',
    },
    ':hover > .glyph-tool-chevron, :focus-visible > .glyph-tool-chevron': { opacity: 1 },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
    'details[open] > & > .glyph-tool-chevron': { transform: 'rotate(90deg)' },
    '@media (hover: none)': { '& > .glyph-tool-chevron': { opacity: 1 } },
  }),
  icon: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: 17,
    height: 17,
    borderRadius: 4,
    background: tokens.button.secondary.background,
    border: tokens.border.default,
    boxSizing: 'border-box',
    color: tokens.text.muted,
  }),
  label: css({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  running: css({
    backgroundImage: `linear-gradient(100deg, ${tokens.text.muted} 43%, ${tokens.text.primary} 50%, ${tokens.text.muted} 57%)`,
    backgroundSize: '300% 100%',
    backgroundRepeat: 'no-repeat',
    backgroundClip: 'text',
    color: 'transparent',
    animation: 'glyph-tool-shimmer 1.8s linear infinite',
    '@keyframes glyph-tool-shimmer': { from: { backgroundPosition: '100% 0' }, to: { backgroundPosition: '0% 0' } },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none', backgroundImage: 'none', color: tokens.text.muted },
    '@media (forced-colors: active)': { animation: 'none', backgroundImage: 'none', color: 'CanvasText' },
  }),
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

function ToolIcon() {
  return (
    <span class={styles.icon} aria-hidden="true">
      <Wrench size={12} strokeWidth={1.5} />
    </span>
  );
}
function Chevron() {
  return <ChevronRight class="glyph-tool-chevron" size={14} aria-hidden="true" />;
}
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
      <details>
        <summary class={`${styles.summary} ${running ? styles.running : ''}`} title={label}>
          <ToolIcon />
          <span class={styles.label}>{label}</span>
          <Chevron />
        </summary>
        <pre class={styles.body}>
          {[tool.arguments && format(tool.arguments), tool.summary && format(tool.summary)]
            .filter(Boolean)
            .join('\n\n') || (running ? 'Waiting for the result…' : 'No details recorded for this call.')}
        </pre>
        <div class={`glyph-tool-status ${styles.status}`}>{status}</div>
      </details>
    </li>
  );
}
function ToolGroup({ tools, active }: { readonly tools: readonly GlyphToolActivity[]; readonly active: boolean }) {
  const running = active && tools.some(tool => tool.status === GlyphToolActivityStatus.STARTED);
  const failures = tools.filter(tool => tool.status === GlyphToolActivityStatus.FAILED).length;
  const interrupted = tools.some(
    tool =>
      tool.status === GlyphToolActivityStatus.INTERRUPTED ||
      (!active && tool.status === GlyphToolActivityStatus.STARTED),
  );
  const list = (
    <ul class={`glyph-tools ${styles.tools}`} aria-label="Tool activity">
      {tools.map(tool => (
        <ToolRow key={tool.id} tool={tool} active={active} />
      ))}
    </ul>
  );
  return tools.length === 1 ? (
    list
  ) : (
    <details class={`glyph-tool-group ${styles.group}`}>
      <summary class={`${styles.summary} ${running ? styles.running : ''}`}>
        <span>{running ? 'Exploring' : 'Explored'}</span>
        <ToolIcon />
        <span>
          {tools.length} tools{failures ? ` · ${failures} failed` : interrupted ? ' · interrupted' : ''}
        </span>
        <Chevron />
      </summary>
      {list}
    </details>
  );
}
export function GlyphTurnProgress({ progress }: { readonly progress: NonNullable<GlyphTranscriptEntry['progress']> }) {
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
        <details class={`glyph-reasoning ${styles.reasoning}`}>
          <summary class={styles.summary}>
            Reasoning summary
            <Chevron />
          </summary>
          <p>{progress.reasoning}</p>
        </details>
      )}
      {groups.map(tools => (
        <ToolGroup key={tools[0]!.id} tools={tools} active={active} />
      ))}
    </section>
  );
}
