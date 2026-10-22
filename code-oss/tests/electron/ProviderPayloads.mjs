import { z } from 'zod';

const toolError = z.looseObject({ code: z.unknown(), message: z.unknown() });
const projectMatch = z.looseObject({ path: z.string(), line: z.number().nullish(), lineText: z.string().nullish() });

export const projectToolOutput = z.looseObject({
  files: z.array(z.string()).nullish(),
  lines: z.array(z.looseObject({})).nullish(),
  matches: z.array(projectMatch).nullish(),
  error: toolError.nullish(),
});

export const editToolOutput = z.looseObject({
  revision: z.string().nullish(),
  error: toolError.nullish(),
});

export const shellToolOutput = z.looseObject({
  terminal_id: z.string().nullish(),
  terminals: z.array(z.looseObject({ output_tail: z.string().nullish() })).nullish(),
  error: toolError.nullish(),
});

export const webToolOutput = z.looseObject({
  error: toolError.nullish(),
});

const contextFile = z.looseObject({
  path: z.string(),
  text: z.string(),
  source: z
    .looseObject({
      range: z.looseObject({ start: z.looseObject({}) }).nullish(),
    })
    .nullish(),
});

export const workspaceContext = z.looseObject({ files: z.array(contextFile) });

export const contextEventMessage = z.looseObject({
  schema: z.string(),
  event: z.looseObject({
    type: z.string(),
    id: z.unknown(),
    payload: z.looseObject({ items: z.array(z.looseObject({ decision: z.string() })).nullish() }).nullish(),
  }),
});

/**
 * @param {string | undefined} text
 * @returns {unknown}
 */
export function parseJson(text) {
  return JSON.parse(text ?? '');
}

/** @param {import('./ScriptedProvider.mjs').ResponseInputItem | undefined} item */
export function contextFiles(item) {
  const content = item?.content;
  if (!Array.isArray(content)) throw new Error('The user message has no attached workspace context.');
  return workspaceContext.parse(parseJson(content[0]?.text)).files;
}
