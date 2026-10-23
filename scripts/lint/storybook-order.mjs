/** @typedef {Parameters<import('oxlint/plugins-dev').RuleTester['run']>[1]} Rule */
/** @typedef {Parameters<NonNullable<Rule['create']>>[0]} Context */
/** @typedef {Context['sourceCode']} SourceCode */
/** @typedef {Parameters<SourceCode['getCommentsBefore']>[0]} Node */
/** @typedef {Parameters<NonNullable<Parameters<Context['report']>[0]['fix']>>[0]} Fixer */

/** Enforce the CSF declaration order used by Glyph's stories. */
/** @type {{ meta: { name: string }, rules: Record<string, Rule> }} */
export default {
  meta: { name: 'glyph-storybook' },
  rules: {
    'declaration-order': {
      meta: {
        type: 'layout',
        docs: { description: 'Place meta, its default export, and StoryObj aliases before story exports.' },
        schema: [],
        fixable: 'code',
        messages: {
          order: 'Place {{name}} before {{previous}} (meta → default export → Story type → stories).',
        },
      },
      create(context) {
        const source = context.sourceCode;
        /**
         * @param {Node} node
         * @param {string} name
         * @param {string} previous
         * @param {Node | null} [anchor]
         */
        const report = (node, name, previous, anchor) => {
          context.report({
            node,
            messageId: 'order',
            data: { name, previous },
            fix: anchor ? fixer => moveAfter(fixer, source, node, anchor) : undefined,
          });
        };
        return {
          Program(program) {
            const statements = program.body;
            const defaultExport = statements.find(node => node.type === 'ExportDefaultDeclaration');
            // Missing exports are a CSF validation concern, not an ordering concern.
            if (!defaultExport) return;
            const metaName = defaultExport.declaration.type === 'Identifier' ? defaultExport.declaration.name : null;
            const meta = statements
              .filter(node => node.type === 'VariableDeclaration')
              .find(node =>
                node.declarations.some(
                  declaration => declaration.id.type === 'Identifier' && declaration.id.name === metaName,
                ),
              );
            const storyTypes = new Set(
              statements
                .filter(node => node.type === 'ImportDeclaration')
                .filter(node => node.source.value.startsWith('@storybook/'))
                .flatMap(node => node.specifiers)
                .filter(node => node.type === 'ImportSpecifier')
                .filter(node => node.imported.type === 'Identifier' && node.imported.name === 'StoryObj')
                .map(node => node.local.name),
            );
            const entries = statements.flatMap(node => {
              if (node === meta) return [{ node, rank: 0, name: 'meta' }];
              if (node === defaultExport) return [{ node, rank: 1, name: 'the default export' }];
              const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
              if (
                declaration?.type === 'TSTypeAliasDeclaration' &&
                declaration.typeAnnotation.type === 'TSTypeReference' &&
                declaration.typeAnnotation.typeName.type === 'Identifier' &&
                storyTypes.has(declaration.typeAnnotation.typeName.name)
              )
                return [{ node, rank: 2, name: 'the Story type' }];
              if (
                node.type === 'ExportNamedDeclaration' &&
                node.exportKind !== 'type' &&
                (declaration?.type === 'VariableDeclaration' ||
                  declaration?.type === 'FunctionDeclaration' ||
                  (!declaration && !node.source && node.specifiers.some(specifier => specifier.exportKind !== 'type')))
              )
                return [{ node, rank: 3, name: 'story exports' }];
              return [];
            });
            const firstStory = entries.find(entry => entry.rank === 3)?.node;
            if (meta && firstStory && meta.range[0] > firstStory.range[0]) {
              // Meta initializers can depend on intervening code; moving them is manual.
              report(meta, 'meta', 'story exports');
            }
            if (meta && defaultExport.range[0] < meta.range[0]) {
              report(defaultExport, 'meta', 'the default export');
            } else if (firstStory && defaultExport.range[0] > firstStory.range[0]) {
              // A const binding always exports the same value, even if its object is mutated.
              const anchor = meta?.kind === 'const' && meta.range[0] < firstStory.range[0] ? meta : null;
              report(defaultExport, 'the default export', 'story exports', anchor);
            }
            for (const entry of entries.filter(entry => entry.rank === 2)) {
              if (
                entry.node.range[0] < defaultExport.range[0] ||
                (firstStory && entry.node.range[0] > firstStory.range[0])
              ) {
                // Type aliases are erased, so moving them across runtime statements is safe.
                const anchor = !firstStory || defaultExport.range[0] < firstStory.range[0] ? defaultExport : null;
                context.report({
                  node: entry.node,
                  message: 'Place the Story type after the default export and before story exports.',
                  fix: anchor ? fixer => moveAfter(fixer, source, entry.node, anchor) : undefined,
                });
              }
            }
          },
        };
      },
    },
  },
};

// Move whole lines so documentation and same-line comments stay with their node.
// Decline compact statements or lint directives rather than changing their meaning.
/**
 * @param {SourceCode} source
 * @param {Node} node
 * @returns {[number, number] | null}
 */
function lineRange(source, node) {
  let start = node.range[0];
  let end = node.range[1];
  for (const comment of source.getCommentsBefore(node).toReversed()) {
    const lineStart = source.text.lastIndexOf('\n', comment.range[0] - 1) + 1;
    if (source.text.slice(lineStart, comment.range[0]).trim()) break;
    start = comment.range[0];
  }
  for (const comment of source.getCommentsAfter(node)) {
    if (comment.loc.start.line !== node.loc.end.line) break;
    end = comment.range[1];
  }
  const lineStart = source.text.lastIndexOf('\n', start - 1) + 1;
  const newline = source.text.indexOf('\n', end);
  const lineEnd = newline < 0 ? source.text.length : newline + 1;
  if (source.text.slice(lineStart, start).trim() || source.text.slice(end, lineEnd).trim()) return null;
  if (/(?:\b(?:oxlint|eslint|prettier)-|@ts-)/u.test(source.text.slice(lineStart, lineEnd))) return null;
  return [lineStart, lineEnd];
}

/**
 * @param {Fixer} fixer
 * @param {SourceCode} source
 * @param {Node} node
 * @param {Node} anchor
 */
function moveAfter(fixer, source, node, anchor) {
  const range = lineRange(source, node);
  const anchorRange = lineRange(source, anchor);
  if (!range || !anchorRange || (anchorRange[0] < range[1] && range[0] < anchorRange[1])) return null;
  const text = source.text.slice(...range);
  return [fixer.removeRange(range), fixer.insertTextAfterRange(anchorRange, text.endsWith('\n') ? text : `${text}\n`)];
}
