import ts from 'typescript';
import { sourceImportPath } from './source-import-path.mjs';

/** Transform JS and declaration imports during emit, retaining original ranges for source maps. */
export function sourceAliasTransformer(context) {
  const factory = context.factory;
  return source => {
    const specifier = node => {
      if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node;
      const path = sourceImportPath(node.text, source.fileName);
      if (path === node.text) return node;
      return ts.setTextRange(ts.setOriginalNode(factory.createStringLiteral(path), node), node);
    };
    const visit = node => {
      node = ts.visitEachChild(node, visit, context);
      if (ts.isImportDeclaration(node))
        return factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          specifier(node.moduleSpecifier),
          node.attributes,
        );
      if (ts.isExportDeclaration(node))
        return factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          specifier(node.moduleSpecifier),
          node.attributes,
        );
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        return factory.updateImportTypeNode(
          node,
          factory.updateLiteralTypeNode(node.argument, specifier(node.argument.literal)),
          node.attributes,
          node.qualifier,
          node.typeArguments,
          node.isTypeOf,
        );
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0])
        return factory.updateCallExpression(node, node.expression, node.typeArguments, [
          specifier(node.arguments[0]),
          ...node.arguments.slice(1),
        ]);
      if (ts.isExternalModuleReference(node))
        return factory.updateExternalModuleReference(node, specifier(node.expression));
      return node;
    };
    return ts.visitNode(source, visit);
  };
}
