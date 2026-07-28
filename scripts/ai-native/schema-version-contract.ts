import { readFileSync } from 'node:fs';
import ts from 'typescript';

export interface SchemaVersionContractResult {
  checked: Array<{ path: string; line: number }>;
  violations: string[];
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function declarations(source: ts.SourceFile): Map<string, ts.Expression> {
  const result = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      result.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function resolveAlias(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, ts.Expression>,
  seen: Set<string>,
): ts.Expression {
  const current = unwrap(expression);
  if (!ts.isIdentifier(current)) return current;
  if (seen.has(current.text)) return current;
  const initializer = aliases.get(current.text);
  if (!initializer) return current;
  seen.add(current.text);
  return resolveAlias(initializer, aliases, seen);
}

function isLiteralValue(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, ts.Expression>,
): boolean {
  const resolved = resolveAlias(expression, aliases, new Set());
  return ts.isStringLiteralLike(resolved)
    || ts.isNumericLiteral(resolved)
    || resolved.kind === ts.SyntaxKind.TrueKeyword
    || resolved.kind === ts.SyntaxKind.FalseKeyword;
}

function isSingleLiteralSchema(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, ts.Expression>,
): boolean {
  const resolved = resolveAlias(expression, aliases, new Set());
  return ts.isCallExpression(resolved)
    && ts.isPropertyAccessExpression(resolved.expression)
    && resolved.expression.name.text === 'literal'
    && resolved.arguments.length === 1
    && isLiteralValue(resolved.arguments[0]!, aliases);
}

interface ResolvedObjectProperty {
  expression: ts.Expression;
  declaration: ts.ObjectLiteralElementLike;
}

interface ResolvedObjectShape {
  properties: Map<string, ResolvedObjectProperty>;
  unresolvedSpreads: ts.SpreadAssignment[];
}

function objectShape(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, ts.Expression>,
  seen: Set<ts.ObjectLiteralExpression> = new Set(),
): ResolvedObjectShape | undefined {
  const resolved = resolveAlias(expression, aliases, new Set());
  if (!ts.isObjectLiteralExpression(resolved) || seen.has(resolved)) return undefined;
  seen.add(resolved);
  const properties = new Map<string, ResolvedObjectProperty>();
  const unresolvedSpreads: ts.SpreadAssignment[] = [];
  for (const property of resolved.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = objectShape(property.expression, aliases, new Set(seen));
      if (!spread) {
        unresolvedSpreads.push(property);
        continue;
      }
      for (const [name, value] of spread.properties) properties.set(name, value);
      unresolvedSpreads.push(...spread.unresolvedSpreads);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name !== undefined) properties.set(name, { expression: property.initializer, declaration: property });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.text, { expression: property.name, declaration: property });
    }
  }
  return { properties, unresolvedSpreads };
}

function propertyName(node: ts.PropertyName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function inspectSchemaVersionSource(path: string, sourceText: string): SchemaVersionContractResult {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = declarations(source);
  const result: SchemaVersionContractResult = { checked: [], violations: [] };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'object'
      && node.arguments[0]
    ) {
      const shape = objectShape(node.arguments[0], aliases);
      for (const spread of shape?.unresolvedSpreads ?? []) {
        const line = source.getLineAndCharacterOfPosition(spread.getStart(source)).line + 1;
        result.violations.push(
          `${path}:${line}: object spread source in a consumer schema must resolve to a static object literal`,
        );
      }
      const version = shape?.properties.get('schema_version');
      if (version) {
        const line = source.getLineAndCharacterOfPosition(version.declaration.getStart(source)).line + 1;
        result.checked.push({ path, line });
        if (!isSingleLiteralSchema(version.expression, aliases)) {
          result.violations.push(
            `${path}:${line}: schema_version must resolve through aliases to exactly one literal schema`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

export function inspectSchemaVersionFiles(paths: readonly string[]): SchemaVersionContractResult {
  const result: SchemaVersionContractResult = { checked: [], violations: [] };
  for (const path of paths) {
    const inspected = inspectSchemaVersionSource(path, readFileSync(path, 'utf8'));
    result.checked.push(...inspected.checked);
    result.violations.push(...inspected.violations);
  }
  return result;
}
