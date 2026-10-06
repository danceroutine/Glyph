import { performance } from 'node:perf_hooks';
import { transformTextEditRanges } from '../transformTextEditRanges.ts';

interface Edit {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly removedText: string;
  readonly insertedText: string;
}

const targetMebibytes = Number(process.argv[2] ?? 1);
const agentCount = 8;
const editsPerAgent = 8;
const humanEditCount = 32;
const payload = 'x'.repeat(384);
const targetBytes = targetMebibytes * 1024 * 1024;
const recordCount = Math.max(256, Math.ceil((targetBytes - 4) / (record(0).length + 2)));

const records = Array.from({ length: recordCount }, (_, index) => record(index));
const base = `[\n${records.join(',\n')}\n]\n`;
records.length = 0;

const occupied = new Set<number>();
const humanEdits: Edit[] = [];
for (let index = 0; index < humanEditCount; index++) {
  const recordIndex = distributedIndex(index, humanEditCount + agentCount * editsPerAgent, recordCount);
  occupied.add(recordIndex);
  const recordStart = findRecord(base, recordIndex);
  if (index % 2 === 0) {
    const ownerStart = base.indexOf('human-000', recordStart);
    humanEdits.push({
      sourceStart: ownerStart,
      sourceEnd: ownerStart + 'human-000'.length,
      removedText: 'human-000',
      insertedText: `user-${index.toString().padStart(3, '0')}`,
    });
  } else {
    const insertion = base.indexOf('"payload":', recordStart);
    humanEdits.push({
      sourceStart: insertion,
      sourceEnd: insertion,
      removedText: '',
      insertedText: `"humanNote":"${index.toString().padStart(3, '0')}",`,
    });
  }
}

const agentEdits: Edit[][] = [];
let distributedCursor = humanEditCount;
for (let agent = 0; agent < agentCount; agent++) {
  const edits: Edit[] = [];
  for (let index = 0; index < editsPerAgent; index++) {
    let recordIndex = distributedIndex(distributedCursor++, humanEditCount + agentCount * editsPerAgent, recordCount);
    while (occupied.has(recordIndex)) recordIndex = (recordIndex + 1) % recordCount;
    occupied.add(recordIndex);
    const statusStart = base.indexOf('pending', findRecord(base, recordIndex));
    edits.push({
      sourceStart: statusStart,
      sourceEnd: statusStart + 'pending'.length,
      removedText: 'pending',
      insertedText: `agent${agent.toString().padStart(2, '0')}`,
    });
  }
  agentEdits.push(edits);
}

let current = applyEdits(base, humanEdits);
const transformMilliseconds: number[] = [];
for (let agent = 0; agent < agentCount; agent++) {
  if (agent > 0 && agent % 2 === 0) current = applyLiveHumanEdit(current, agent, recordCount);
  const edits = agentEdits[agent]!;
  const started = performance.now();
  const transformed = transformTextEditRanges(base, current, edits);
  transformMilliseconds.push(performance.now() - started);
  if (!transformed) throw new Error(`Agent ${agent + 1} could not be transformed.`);
  current = applyEdits(
    current,
    edits.map((edit, index) => ({ ...edit, ...transformed[index]! })),
  );
}

const sorted = [...transformMilliseconds].sort((left, right) => left - right);
const memory = process.memoryUsage();
process.stdout.write(
  `${JSON.stringify({
    mebibytes: Buffer.byteLength(base) / 1024 / 1024,
    records: recordCount,
    agents: agentCount,
    editsPerAgent,
    initialHumanEdits: humanEditCount,
    interleavedHumanEdits: 3,
    medianTransformMilliseconds: percentile(sorted, 0.5),
    p95TransformMilliseconds: percentile(sorted, 0.95),
    maximumTransformMilliseconds: sorted.at(-1) ?? 0,
    totalTransformMilliseconds: transformMilliseconds.reduce((sum, value) => sum + value, 0),
    rssMebibytes: memory.rss / 1024 / 1024,
    heapUsedMebibytes: memory.heapUsed / 1024 / 1024,
  })}\n`,
);

function record(index: number): string {
  return `  {"id":"${index.toString().padStart(8, '0')}","status":"pending","owner":"human-000","payload":"${payload}"}`;
}

function findRecord(text: string, index: number): number {
  return text.indexOf(`"id":"${index.toString().padStart(8, '0')}"`);
}

function distributedIndex(index: number, total: number, count: number): number {
  return Math.min(count - 1, Math.floor(((index + 1) * count) / (total + 1)));
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.sourceStart - left.sourceStart)) {
    if (result.slice(edit.sourceStart, edit.sourceEnd) !== edit.removedText) {
      throw new Error(`Expected text mismatch at ${edit.sourceStart}..${edit.sourceEnd}.`);
    }
    result = result.slice(0, edit.sourceStart) + edit.insertedText + result.slice(edit.sourceEnd);
  }
  return result;
}

function applyLiveHumanEdit(text: string, sequence: number, count: number): string {
  const recordIndex = Math.min(count - 1, Math.floor(((sequence * 17 + 3) * count) / 211));
  const recordStart = findRecord(text, recordIndex);
  const payloadStart = text.indexOf(payload, recordStart);
  if (recordStart < 0 || payloadStart < 0) throw new Error('Could not locate live human edit target.');
  const replacement = `LIVE${sequence.toString().padStart(4, '0')}${payload.slice(8)}`;
  return text.slice(0, payloadStart) + replacement + text.slice(payloadStart + payload.length);
}

function percentile(values: readonly number[], quantile: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)] ?? 0;
}
