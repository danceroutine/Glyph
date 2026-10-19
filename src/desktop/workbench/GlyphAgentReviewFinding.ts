export interface GlyphAgentReviewFinding {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly title: string;
  readonly body: string;
}

/** Only complete, bounded records referring to captured files become actionable findings. */
export function parseGlyphAgentReviewFindings(
  text: string,
  files: ReadonlyMap<string, number>,
): { findings: GlyphAgentReviewFinding[]; complete: boolean } {
  const report = text.split('<glyph_review>')[1];
  const body = report?.split('</glyph_review>')[0] ?? '';
  let valid = report?.includes('</glyph_review>') ?? false;
  const findings: GlyphAgentReviewFinding[] = [];
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
    if ('complete' in value && value.complete === true) {
      complete = true;
      continue;
    }
    if (!(
      'path' in value &&
      typeof value.path === 'string' &&
      files.has(value.path) &&
      'line' in value &&
      typeof value.line === 'number' &&
      Number.isSafeInteger(value.line) &&
      value.line >= 1 &&
      value.line <= files.get(value.path)! &&
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
      title: value.title,
      body: value.body,
    });
  }
  return { findings, complete: complete && valid };
}
