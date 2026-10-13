import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The store's real migration/reopen tests cover persistence. This composition
// check guards the CLI entrypoint without launching auth or an interactive TTY.
it('[round7-04] binds CLI review persistence to the resolved workspace mutation scope', async () => {
  const source = ts.createSourceFile('cli.ts', await readFile('src/cli.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const stores: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'FileProposalReviewStore') stores.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(stores).toHaveLength(1);
  expect(stores[0]?.arguments?.[1]?.getText(source)).toMatch(/mutationScope:\s*projectContext\.mutationIdentity/);
});
