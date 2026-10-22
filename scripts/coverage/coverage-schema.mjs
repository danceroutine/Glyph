import { z } from 'zod';

// V8 reports unmapped positions as empty objects and end-of-line columns as
// Infinity, which JSON encodes as null. Line zero denotes no source location.
const location = z.object({
  line: z.number().default(0),
  column: z
    .number()
    .nullable()
    .default(0)
    .transform(value => value ?? Infinity),
});
const range = z.object({ start: location, end: location });
export const coverageSchema = z.record(
  z.string(),
  z.object({
    path: z.string(),
    statementMap: z.record(z.string(), range),
    fnMap: z.record(z.string(), z.object({ name: z.string(), decl: range, loc: range, line: z.number().default(0) })),
    branchMap: z.record(
      z.string(),
      z.object({ type: z.string(), loc: range, locations: z.array(range), line: z.number() }),
    ),
    s: z.record(z.string(), z.number()),
    f: z.record(z.string(), z.number()),
    b: z.record(z.string(), z.array(z.number())),
  }),
);

export const processCoverageSchema = z.object({
  result: z.array(
    z.object({
      scriptId: z.string(),
      url: z.string(),
      functions: z.array(
        z.object({
          functionName: z.string(),
          isBlockCoverage: z.boolean(),
          ranges: z.array(z.object({ startOffset: z.number(), endOffset: z.number(), count: z.number() })),
        }),
      ),
    }),
  ),
});

export const sourceMapSchema = z.object({
  version: z.number(),
  sources: z.array(z.string()),
  mappings: z.string(),
  names: z.array(z.string()).default([]),
  sourcesContent: z.array(z.string().nullable()).optional(),
  sourceRoot: z.string().optional(),
  file: z.string().optional(),
});
