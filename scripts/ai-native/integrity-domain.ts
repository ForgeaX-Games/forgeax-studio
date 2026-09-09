#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const INTEGRITY_DOMAIN_GENERATED_PATH = 'scripts/ai-native/integrity-domain.generated.json';

export interface IntegrityDomainManifest {
  schema_version: 1;
  derivation: 'enforcement-domain-and-scanner-inputs-content-v5';
  roots: {
    package_scripts: string[];
    workflows: string[];
    entrypoints: string[];
  };
  domain_files: string[];
  /** Every executable/configuration byte in the anti-tamper enforcement domain. */
  configuration_files: string[];
  configuration_file_hashes: Array<{ path: string; sha256: string }>;
  /** Inputs whose bytes can change the inventory scan result without a product-tree change. */
  scanner_configuration_files: string[];
  snapshot_boundary_inputs: string[];
  cross_package_value_imports: Array<{
    importer: string;
    target: string;
    reason: string;
  }>;
}

export const SCANNER_CONFIGURATION_INPUT_FILES = [
  '.forgeax-harness/docs/ai-native/other-team-gap-ownership.md',
  'scripts/ai-native/alias-map.json',
  'scripts/ai-native/exclusions.json',
  'scripts/ai-native/manual-pool-effect-promotions.json',
  'scripts/ai-native/other-team-route-registry.json',
  'scripts/ai-native/scanner-config.json',
  'scripts/ai-native/vocab-config.json',
] as const;

const STATIC_RESOURCE_REGISTRATIONS: ReadonlyArray<{
  consumer: string;
  resources: readonly string[];
}> = [
  { consumer: 'scripts/ai-native/pr-gates.ts', resources: [
    'scripts/ai-native/effect-adjudications-v1.jsonl',
    'scripts/ai-native/evidence-manifests-v1',
    'scripts/ai-native/manual-pool-adjudications-v1.jsonl',
  ] },
  { consumer: 'scripts/ai-native/scanner.ts', resources: [
    '.forgeax-harness/docs/ai-native/other-team-gap-ownership.md',
    'scripts/ai-native/alias-map.json',
    'scripts/ai-native/exclusions.json',
    'scripts/ai-native/manual-pool-effect-promotions.json',
    'scripts/ai-native/other-team-route-registry.json',
    'scripts/ai-native/scanner-config.json',
    'scripts/ai-native/vocab-config.json',
  ] },
  { consumer: 'scripts/ai-native/typecheck-ai-native.ts', resources: [
    'scripts/ai-native/tsconfig.json',
  ] },
] as const;

const GENERATED_CONFIGURATION_OUTPUT_PREFIXES = [
  'scripts/ai-native/evidence-manifests-v1/',
] as const;

const CROSS_PACKAGE_RUNTIME_IMPORT_REASONS: Readonly<Record<string, string>> = {
} as const;

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(root: string, absolutePath: string): string {
  return slash(relative(root, absolutePath));
}

function resolveModule(importer: string, specifier: string): string | undefined {
  const candidate = resolve(dirname(importer), specifier);
  const candidates = /\.(?:ts|tsx|json)$/.test(extname(candidate))
    ? [candidate]
    : [
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.json`,
        join(candidate, 'index.ts'),
        join(candidate, 'index.tsx'),
      ];
  return candidates.find((path) => existsSync(path) && lstatSync(path).isFile());
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
  return clause.namedBindings.elements.length > 0
    && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

type LoaderResolution = 'loader' | 'not-loader' | 'ambiguous';

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function mergeLoaderResolutions(resolutions: readonly LoaderResolution[]): LoaderResolution {
  if (resolutions.includes('ambiguous')) return 'ambiguous';
  const hasLoader = resolutions.includes('loader');
  const hasNonLoader = resolutions.includes('not-loader');
  return hasLoader && hasNonLoader ? 'ambiguous' : hasLoader ? 'loader' : 'not-loader';
}

function loaderCallResolver(source: ts.SourceFile): (expression: ts.Expression) => LoaderResolution {
  const bindings = new Map<string, ts.Expression[]>();
  const directLoaderBindings = new Set<string>();
  const addBinding = (name: string, expression: ts.Expression): void => {
    bindings.set(name, [...(bindings.get(name) ?? []), expression]);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        addBinding(node.name.text, node.initializer);
      } else if (
        ts.isObjectBindingPattern(node.name)
        && ts.isIdentifier(unwrapExpression(node.initializer))
        && (unwrapExpression(node.initializer) as ts.Identifier).text === 'module'
      ) {
        for (const element of node.name.elements) {
          const property = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(element.name)
            && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))
            && property.text === 'require'
          ) directLoaderBindings.add(element.name.text);
        }
      }
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      addBinding(node.left.text, node.right);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const conditionalResolutions = (
    expression: ts.Expression,
    resolver: (candidate: ts.Expression, seen: Set<string>) => LoaderResolution,
    seen: Set<string>,
  ): LoaderResolution | undefined => {
    if (ts.isConditionalExpression(expression)) {
      return mergeLoaderResolutions([
        resolver(expression.whenTrue, new Set(seen)),
        resolver(expression.whenFalse, new Set(seen)),
      ]);
    }
    if (
      ts.isBinaryExpression(expression)
      && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)
    ) {
      return mergeLoaderResolutions([
        resolver(expression.left, new Set(seen)),
        resolver(expression.right, new Set(seen)),
      ]);
    }
    return undefined;
  };

  const resolveFactory = (input: ts.Expression, seen: Set<string>): LoaderResolution => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression) && expression.text === 'createRequire') return 'loader';
    const conditional = conditionalResolutions(expression, resolveFactory, seen);
    if (conditional) return conditional;
    if (!ts.isIdentifier(expression)) return 'not-loader';
    const key = `factory:${expression.text}`;
    if (seen.has(key)) return 'ambiguous';
    const initializers = bindings.get(expression.text);
    if (!initializers?.length) return 'not-loader';
    seen.add(key);
    return mergeLoaderResolutions(initializers.map((initializer) => (
      resolveFactory(initializer, new Set(seen))
    )));
  };

  const resolveLoader = (input: ts.Expression, seen: Set<string>): LoaderResolution => {
    const expression = unwrapExpression(input);
    if (ts.isIdentifier(expression)) {
      if (expression.text === 'require' || directLoaderBindings.has(expression.text)) return 'loader';
      const key = `loader:${expression.text}`;
      if (seen.has(key)) return 'ambiguous';
      const initializers = bindings.get(expression.text);
      if (!initializers?.length) return 'not-loader';
      seen.add(key);
      return mergeLoaderResolutions(initializers.map((initializer) => (
        resolveLoader(initializer, new Set(seen))
      )));
    }
    if (
      ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === 'module'
      && expression.name.text === 'require'
    ) return 'loader';
    if (
      ts.isElementAccessExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === 'module'
      && expression.argumentExpression
      && ts.isStringLiteralLike(expression.argumentExpression)
      && expression.argumentExpression.text === 'require'
    ) return 'loader';
    const conditional = conditionalResolutions(expression, resolveLoader, seen);
    if (conditional) return conditional;
    if (ts.isCallExpression(expression)) {
      const factory = resolveFactory(expression.expression, new Set(seen));
      if (factory !== 'not-loader') return factory;
      if (
        ts.isPropertyAccessExpression(expression.expression)
        && expression.expression.name.text === 'bind'
      ) return resolveLoader(expression.expression.expression, new Set(seen));
    }
    return 'not-loader';
  };

  return (expression) => resolveLoader(expression, new Set());
}

function registeredResources(root: string, importerRel: string): string[] {
  const resources = new Set<string>();
  const registrations = STATIC_RESOURCE_REGISTRATIONS.filter((item) => item.consumer === importerRel);
  for (const registration of registrations) {
    for (const value of registration.resources) {
      const candidate = resolve(root, value);
      if (!existsSync(candidate)) throw new Error(`registered integrity resource is missing: ${value}`);
      if (lstatSync(candidate).isDirectory()) {
        for (const name of readdirSync(candidate).sort(codePointCompare)) {
          const child = join(candidate, name);
          if (lstatSync(child).isFile()) resources.add(repositoryPath(root, child));
        }
      } else if (lstatSync(candidate).isFile()) {
        resources.add(repositoryPath(root, candidate));
      } else {
        throw new Error(`registered integrity resource is not a regular file or directory: ${value}`);
      }
    }
  }
  return [...resources].sort(codePointCompare);
}

export function renderIntegrityDomainManifest(manifest: IntegrityDomainManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function deriveIntegrityDomain(repoRoot: string): IntegrityDomainManifest {
  const root = resolve(repoRoot);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const packageScripts = Object.entries(packageJson.scripts ?? {})
    .filter(([, command]) => command.includes('scripts/ai-native/'))
    .map(([name]) => name)
    .sort(codePointCompare);
  const entrypoints = new Set<string>(['scripts/ai-native/integrity-domain.ts']);
  for (const name of packageScripts) {
    const command = packageJson.scripts?.[name] ?? '';
    for (const match of command.matchAll(/scripts\/ai-native\/[A-Za-z0-9_./-]+\.ts/g)) {
      if (existsSync(resolve(root, match[0]))) entrypoints.add(match[0]);
    }
  }

  const workflowRoot = join(root, '.github/workflows');
  const workflows = readdirSync(workflowRoot)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .filter((name) => {
      const text = readFileSync(join(workflowRoot, name), 'utf8');
      return text.includes('scripts/ai-native/')
        || text.includes('ai_native')
        || packageScripts.some((script) => text.includes(`bun run ${script}`));
    })
    .map((name) => `.github/workflows/${name}`)
    .sort(codePointCompare);

  const domainFiles = new Set<string>(['package.json', ...workflows]);
  const crossPackageValueImports: IntegrityDomainManifest['cross_package_value_imports'] = [];
  const pending = [...entrypoints].sort(codePointCompare);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const importerRel = pending.shift()!;
    if (visited.has(importerRel)) continue;
    visited.add(importerRel);
    domainFiles.add(importerRel);
    const importer = resolve(root, importerRel);
    const ast = sourceFile(importer);
    const resolveLoaderCall = loaderCallResolver(ast);
    for (const resource of registeredResources(root, importerRel)) {
      domainFiles.add(resource);
      if (resource.endsWith('.ts') && !visited.has(resource)) pending.push(resource);
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error(`dynamic import is forbidden in the integrity computation domain: ${importerRel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
      }
      let specifier: string | undefined;
      let typeOnly = false;
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
        typeOnly = isTypeOnlyImport(node);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier = node.moduleSpecifier.text;
        typeOnly = node.isTypeOnly;
      } else if (
        ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && node.moduleReference.expression
        && ts.isStringLiteral(node.moduleReference.expression)
      ) {
        specifier = node.moduleReference.expression.text;
        typeOnly = node.isTypeOnly;
      } else if (ts.isCallExpression(node)) {
        const loaderResolution = resolveLoaderCall(node.expression);
        if (loaderResolution === 'ambiguous') {
          throw new Error(`statically indeterminate loader alias is forbidden in the integrity computation domain: ${importerRel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
        }
        if (
          loaderResolution === 'loader'
          && (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]!))
        ) {
          throw new Error(`non-static require is forbidden in the integrity computation domain: ${importerRel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
        }
        if (loaderResolution === 'loader') specifier = (node.arguments[0] as ts.StringLiteralLike).text;
      }
      if (specifier && !typeOnly && specifier.startsWith('.')) {
        const target = resolveModule(importer, specifier);
        if (!target) throw new Error(`unresolved value import in integrity domain: ${importerRel} -> ${specifier}`);
        const targetRel = repositoryPath(root, target);
        if (targetRel.startsWith('scripts/ai-native/')) {
          if (!visited.has(targetRel)) pending.push(targetRel);
        } else if (targetRel.startsWith('packages/')) {
          const key = `${importerRel} -> ${targetRel}`;
          const reason = CROSS_PACKAGE_RUNTIME_IMPORT_REASONS[key];
          if (!reason) throw new Error(`unregistered cross-package value import in integrity domain: ${key}`);
          crossPackageValueImports.push({ importer: importerRel, target: targetRel, reason });
        } else {
          throw new Error(`value import escapes the allowed integrity zones: ${importerRel} -> ${targetRel}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    pending.sort(codePointCompare);
  }

  const sortedDomainFiles = [...domainFiles].sort(codePointCompare);
  const configurationFiles = sortedDomainFiles.filter((path) => (
    !GENERATED_CONFIGURATION_OUTPUT_PREFIXES.some((prefix) => path.startsWith(prefix))
  ));
  const configurationFileHashes = configurationFiles.map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
  }));
  const scannerConfigurationFiles = SCANNER_CONFIGURATION_INPUT_FILES.filter((path) => (
    configurationFiles.includes(path)
  ));
  const missingScannerConfigurationFiles = SCANNER_CONFIGURATION_INPUT_FILES.filter((path) => (
    !scannerConfigurationFiles.includes(path)
  ));
  if (missingScannerConfigurationFiles.length > 0) {
    throw new Error(
      `scanner configuration inputs missing from enforcement domain: ${missingScannerConfigurationFiles.join(', ')}`,
    );
  }
  const boundaryInputs = [...new Set([...scannerConfigurationFiles, 'bun.lock'])].sort(codePointCompare);
  crossPackageValueImports.sort((left, right) => (
    codePointCompare(`${left.importer}\0${left.target}`, `${right.importer}\0${right.target}`)
  ));
  return {
    schema_version: 1,
    derivation: 'enforcement-domain-and-scanner-inputs-content-v5',
    roots: {
      package_scripts: packageScripts,
      workflows,
      entrypoints: [...entrypoints].sort(codePointCompare),
    },
    domain_files: sortedDomainFiles,
    configuration_files: configurationFiles,
    configuration_file_hashes: configurationFileHashes,
    scanner_configuration_files: scannerConfigurationFiles,
    snapshot_boundary_inputs: boundaryInputs,
    cross_package_value_imports: crossPackageValueImports,
  };
}

export function assertIntegrityDomainGenerated(repoRoot: string): IntegrityDomainManifest {
  const root = resolve(repoRoot);
  const derived = deriveIntegrityDomain(root);
  const expected = renderIntegrityDomainManifest(derived);
  const generatedPath = resolve(root, INTEGRITY_DOMAIN_GENERATED_PATH);
  const actual = existsSync(generatedPath) ? readFileSync(generatedPath, 'utf8') : '';
  if (actual !== expected) {
    throw new Error(`integrity domain generated artifact is stale: ${INTEGRITY_DOMAIN_GENERATED_PATH}`);
  }
  return derived;
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, '../..');
    const mode = process.argv[2];
    if (!['--write', '--check'].includes(mode ?? '') || process.argv.length !== 3) {
      throw new Error('usage: integrity-domain.ts (--write|--check)');
    }
    const derived = deriveIntegrityDomain(root);
    if (mode === '--write') {
      writeFileSync(resolve(root, INTEGRITY_DOMAIN_GENERATED_PATH), renderIntegrityDomainManifest(derived));
      process.stdout.write(`[integrity-domain] WROTE ${INTEGRITY_DOMAIN_GENERATED_PATH}\n`);
    } else {
      assertIntegrityDomainGenerated(root);
      process.stdout.write(`[integrity-domain] PASS files=${derived.domain_files.length} cross-package=${derived.cross_package_value_imports.length}\n`);
    }
  } catch (error) {
    console.error(`[integrity-domain] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
