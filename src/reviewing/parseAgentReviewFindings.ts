import type { AgentReviewFinding } from './AgentReview.ts';

export interface AgentReviewFileLines {
  readonly original: number;
  readonly modified: number;
  readonly defaultSide: 'original' | 'modified';
}
/** Only complete, bounded records referring to captured files become actionable findings. */
export function parseAgentReviewFindings(
  text: string,
  files: ReadonlyMap<string, AgentReviewFileLines>,
): { findings: AgentReviewFinding[]; complete: boolean } {
  const report = text.split('<glyph_review>')[1];
  const body = report?.split('</glyph_review>')[0] ?? '';
  let valid =
    (report?.includes('</glyph_review>') ?? false) &&
    text.split('<glyph_review>').length === 2 &&
    text.split('</glyph_review>').length === 2;
  const findings: AgentReviewFinding[] = [];
  let complete = false;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      valid = false;
      continue;
    }
    if (!value || typeof value !== 'object') {
      valid = false;
      continue;
    }
    if (complete) {
      valid = false;
      continue;
    }
    if ('complete' in value && value.complete === true && Object.keys(value).length === 1) {
      complete = true;
      continue;
    }
    const file = 'path' in value && typeof value.path === 'string' ? files.get(value.path) : undefined;
    const side = 'side' in value ? value.side : file?.defaultSide;
    if (!(
      Object.keys(value).every(key => ['path', 'line', 'side', 'title', 'body'].includes(key)) &&
      'path' in value &&
      typeof value.path === 'string' &&
      file &&
      (side === 'original' || side === 'modified') &&
      'line' in value &&
      typeof value.line === 'number' &&
      Number.isSafeInteger(value.line) &&
      value.line >= 1 &&
      value.line <= file[side] &&
      'title' in value &&
      typeof value.title === 'string' &&
      value.title.trim() &&
      value.title.length <= 300 &&
      'body' in value &&
      typeof value.body === 'string' &&
      value.body.trim() &&
      value.body.length <= 8000
    )) {
      valid = false;
      continue;
    }
    if (findings.length === 100) {
      valid = false;
      break;
    }
    findings.push({
      id: `${value.path}:${value.line}:${findings.length}`,
      path: value.path,
      line: value.line,
      side,
      title: value.title,
      body: value.body,
    });
  }
  return { findings, complete: complete && valid };
}
