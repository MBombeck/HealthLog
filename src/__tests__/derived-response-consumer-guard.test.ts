/**
 * Per-envelope response/consumer guard for `GET /api/insights/derived`.
 *
 * The registered Zod response schema is the producer. Each meaningful leaf is
 * tied to the derived-insights component that reads it, or to one exact
 * documented wire-only exception. The matcher never searches for an unqualified
 * field name, so generic names such as `status`, `source`, and `score` cannot be
 * satisfied by another response family.
 *
 * This is one per-envelope adoption point, not a claim that every GET response
 * in the application has the same protection.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCHEMA_FILE = join(ROOT, "src/lib/openapi/routes/insights/schemas.ts");
// Shared component schemas the insights schemas import by name (the AI
// capability state). Resolved from their own file, never guessed.
const IMPORTED_SCHEMA_FILES = [join(ROOT, "src/lib/openapi/routes/profile.ts")];
const PATH_FILE = join(ROOT, "src/lib/openapi/routes/insights/paths.ts");
const ROUTE_FILE = join(ROOT, "src/app/api/insights/derived/route.ts");
const BATCH_ROUTE_FILE = join(
  ROOT,
  "src/app/api/insights/derived/batch/route.ts",
);
const DERIVED_TYPES_FILE = join(ROOT, "src/lib/insights/derived/types.ts");
const ASSESSMENT_TYPES_FILE = join(
  ROOT,
  "src/lib/insights/derived/derived-assessment.ts",
);
const DERIVED_COMPONENTS = join(ROOT, "src/components/insights/derived");
const DERIVED_BATCH_CLIENT = join(DERIVED_COMPONENTS, "use-derived-metric.ts");
const VITALS_DASHBOARD = join(DERIVED_COMPONENTS, "vitals-dashboard.tsx");

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function propertyName(
  name: ts.PropertyName,
  file: ts.SourceFile,
): string | null {
  if (ts.isComputedPropertyName(name)) return null;
  return name.getText(file).replace(/^['"]|['"]$/g, "");
}

function expressionAccessPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const base = expressionAccessPath(expression.expression);
    return base === null ? null : `${base}.${expression.name.text}`;
  }
  if (ts.isElementAccessExpression(expression)) {
    const base = expressionAccessPath(expression.expression);
    const key = expression.argumentExpression;
    if (
      base !== null &&
      key &&
      (ts.isStringLiteral(key) || ts.isNumericLiteral(key))
    ) {
      return `${base}.${key.text}`;
    }
    return null;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionAccessPath(expression.expression);
  }
  return null;
}

function executableAccesses(path: string): Set<string> {
  const accesses = new Set<string>();
  const file = parse(path);
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const access = expressionAccessPath(node);
      if (access !== null) accesses.add(access);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return accesses;
}

interface ZodObjectShape {
  leaves: string[];
  arrays: string[];
}

const TRANSPARENT_ZOD_METHODS = [
  "meta",
  "describe",
  "nullable",
  "optional",
  "default",
  "catch",
  "readonly",
  "brand",
] as const;

const LEAF_ZOD_METHODS = [
  "string",
  "number",
  "boolean",
  "enum",
  "literal",
  "record",
  "datetime",
  "int",
] as const;

function zodObjectShape(path: string, schemaName: string): ZodObjectShape {
  const file = parse(path);
  const initializers = new Map<string, ts.Expression>();
  const arrays = new Set<string>();
  // The schema file's own declarations win; an imported component fills in
  // only a name the file does not declare itself.
  for (const source of [file, ...IMPORTED_SCHEMA_FILES.map(parse)]) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          !initializers.has(declaration.name.text)
        ) {
          initializers.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  function collect(
    expression: ts.Expression,
    prefix: string,
    seen: Set<string>,
  ): string[] {
    let current = expression;
    while (ts.isCallExpression(current)) {
      const callee = current.expression;
      expect(
        ts.isPropertyAccessExpression(callee),
        `${prefix || schemaName} contains an unsupported Zod call: ${current.getText(file)}`,
      ).toBe(true);
      if (!ts.isPropertyAccessExpression(callee)) return [prefix];
      const method = callee.name.text;
      if (method === "object") {
        const object = current.arguments[0];
        expect(
          object && ts.isObjectLiteralExpression(object),
          `${prefix || schemaName} must use a literal z.object shape`,
        ).toBe(true);
        return (object as ts.ObjectLiteralExpression).properties.flatMap(
          (property) => {
            expect(
              ts.isPropertyAssignment(property),
              `${prefix || schemaName} contains unsupported Zod object syntax: ${property.getText(file)}`,
            ).toBe(true);
            if (!ts.isPropertyAssignment(property)) return [];
            // The node may come from an imported schema file.
            const name = propertyName(property.name, property.getSourceFile());
            expect(
              name,
              `${prefix || schemaName} contains a computed property name`,
            ).not.toBeNull();
            if (name === null) return [];
            const child = prefix ? `${prefix}.${name}` : name;
            return collect(property.initializer, child, new Set(seen));
          },
        );
      }
      if (method === "array") {
        const item = current.arguments[0];
        expect(
          item,
          `${prefix} array must declare its item schema`,
        ).toBeDefined();
        arrays.add(prefix);
        return collect(item!, prefix, new Set(seen));
      }
      if (
        LEAF_ZOD_METHODS.includes(method as (typeof LEAF_ZOD_METHODS)[number])
      ) {
        return [prefix];
      }
      expect(
        TRANSPARENT_ZOD_METHODS.includes(
          method as (typeof TRANSPARENT_ZOD_METHODS)[number],
        ),
        `${prefix || schemaName} uses unsupported or shape-changing Zod method .${method}()`,
      ).toBe(true);
      if (
        !TRANSPARENT_ZOD_METHODS.includes(
          method as (typeof TRANSPARENT_ZOD_METHODS)[number],
        )
      ) {
        return [prefix];
      }
      current = callee.expression;
    }

    if (ts.isIdentifier(current)) {
      const referenced = initializers.get(current.text);
      if (referenced) {
        expect(
          seen.has(current.text),
          `cyclic Zod schema reference at ${current.text}`,
        ).toBe(false);
        return collect(referenced, prefix, new Set(seen).add(current.text));
      }
      expect(
        false,
        `${prefix || schemaName} references unknown schema ${current.text}`,
      ).toBe(true);
    }
    return [prefix];
  }

  const root = initializers.get(schemaName);
  expect(root, `${schemaName} must remain a declared Zod schema`).toBeDefined();
  return {
    leaves: [...new Set(collect(root!, "", new Set([schemaName])))].sort(),
    arrays: [...arrays].sort(),
  };
}

function apiSuccessObjectBranches(path: string): string[][] {
  const file = parse(path);
  const branches: string[][] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "apiSuccess"
    ) {
      const payload = node.arguments[0];
      expect(
        payload && ts.isObjectLiteralExpression(payload),
        `${path} apiSuccess payload must remain an object literal`,
      ).toBe(true);
      if (payload && ts.isObjectLiteralExpression(payload)) {
        const fields = payload.properties.flatMap((property) => {
          expect(
            ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property),
            `${path} contains unsupported apiSuccess syntax: ${property.getText(file)}`,
          ).toBe(true);
          if (
            !ts.isPropertyAssignment(property) &&
            !ts.isShorthandPropertyAssignment(property)
          ) {
            return [];
          }
          const name = propertyName(property.name, file);
          expect(name, `${path} has a computed response field`).not.toBeNull();
          return name === null ? [] : [name];
        });
        branches.push([...new Set(fields)]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(file);

  expect(
    branches.length,
    `${path} must still return at least one apiSuccess(...) branch`,
  ).toBeGreaterThan(0);
  return branches;
}
function assertPathResponseEnvelope(
  path: string,
  apiPath: string,
  schemaName: string,
  envelopeName: string,
): void {
  const file = parse(path);
  const routeProperties: ts.PropertyAssignment[] = [];
  function findRoute(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name, file) === apiPath
    ) {
      routeProperties.push(node);
      return;
    }
    ts.forEachChild(node, findRoute);
  }
  findRoute(file);
  expect(
    routeProperties,
    `${apiPath} must have exactly one OpenAPI path entry`,
  ).toHaveLength(1);

  const envelopes: ts.CallExpression[] = [];
  function findEnvelope(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "dataEnvelope"
    ) {
      envelopes.push(node);
    }
    ts.forEachChild(node, findEnvelope);
  }
  findEnvelope(routeProperties[0].initializer);
  expect(
    envelopes,
    `${apiPath} must register exactly one response envelope`,
  ).toHaveLength(1);
  const envelope = envelopes[0];
  expect(
    envelope.arguments.length === 2 &&
      ts.isIdentifier(envelope.arguments[0]) &&
      envelope.arguments[0].text === schemaName &&
      ts.isStringLiteral(envelope.arguments[1]) &&
      envelope.arguments[1].text === envelopeName,
    `${apiPath} must register ${schemaName} as ${envelopeName}`,
  ).toBe(true);
}

function interfaceShape(path: string, interfaceName: string): ZodObjectShape {
  const file = parse(path);
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName,
  );
  expect(
    declaration,
    `${interfaceName} must remain an interface in ${path}`,
  ).toBeDefined();
  const leaves: string[] = [];
  const arrays: string[] = [];
  for (const member of declaration!.members) {
    expect(
      ts.isPropertySignature(member) &&
        member.name !== undefined &&
        member.type,
      `${interfaceName} contains unsupported member syntax`,
    ).toBeTruthy();
    if (
      !ts.isPropertySignature(member) ||
      member.name === undefined ||
      !member.type
    ) {
      continue;
    }
    const name = propertyName(member.name, file);
    expect(name, `${interfaceName} has a computed field`).not.toBeNull();
    if (name === null) continue;
    leaves.push(name);
    if (
      ts.isArrayTypeNode(member.type) ||
      (ts.isTypeReferenceNode(member.type) &&
        ts.isIdentifier(member.type.typeName) &&
        member.type.typeName.text === "Array")
    ) {
      arrays.push(name);
    }
  }
  return { leaves: leaves.sort(), arrays: arrays.sort() };
}

function expressionLineage(expression: ts.Expression): string[] {
  const accesses = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const access = expressionAccessPath(node);
      if (access !== null) accesses.add(access);
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  if (ts.isIdentifier(expression)) accesses.add(expression.text);
  return [...accesses].sort();
}

function apiSuccessLineageBranches(
  path: string,
): Array<Record<string, string[]>> {
  const file = parse(path);
  const branches: Array<Record<string, string[]>> = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "apiSuccess"
    ) {
      const payload = node.arguments[0];
      expect(
        payload && ts.isObjectLiteralExpression(payload),
        `${path} apiSuccess payload must remain an object literal`,
      ).toBe(true);
      if (payload && ts.isObjectLiteralExpression(payload)) {
        const lineage: Record<string, string[]> = {};
        for (const property of payload.properties) {
          expect(
            ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property),
            `${path} contains unsupported apiSuccess syntax: ${property.getText(file)}`,
          ).toBe(true);
          if (ts.isPropertyAssignment(property)) {
            // The node may come from an imported schema file.
            const name = propertyName(property.name, property.getSourceFile());
            expect(
              name,
              `${path} has a computed response field`,
            ).not.toBeNull();
            if (name !== null) {
              lineage[name] = expressionLineage(property.initializer);
            }
          } else if (ts.isShorthandPropertyAssignment(property)) {
            lineage[property.name.text] = [property.name.text];
          }
        }
        branches.push(lineage);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(branches.length).toBeGreaterThan(0);
  return branches;
}

function variableCall(path: string, variableName: string): string | null {
  const file = parse(path);
  let callee: string | null = null;
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      expect(callee).toBeNull();
      let initializer = node.initializer;
      while (
        ts.isAwaitExpression(initializer) ||
        ts.isParenthesizedExpression(initializer)
      ) {
        initializer = initializer.expression;
      }
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression)
      ) {
        callee = initializer.expression.text;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return callee;
}

function expressionReferences(expression: ts.Expression): string[] {
  const references = new Set(expressionLineage(expression));
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text !== "undefined") {
      const parent = node.parent;
      const belongsToAccess =
        (ts.isPropertyAccessExpression(parent) &&
          (parent.expression === node || parent.name === node)) ||
        (ts.isElementAccessExpression(parent) &&
          (parent.expression === node || parent.argumentExpression === node));
      if (!belongsToAccess) references.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return [...references].sort();
}

function assertJsxHandoff(
  path: string,
  componentName: string,
  expected: Readonly<Record<string, readonly string[]>>,
): void {
  const file = parse(path);
  const handoffs: Array<Record<string, string[]>> = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === componentName
    ) {
      const handoff: Record<string, string[]> = {};
      for (const propName of Object.keys(expected)) {
        const attribute = node.attributes.properties.find(
          (property) =>
            ts.isJsxAttribute(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === propName,
        );
        if (
          attribute &&
          ts.isJsxAttribute(attribute) &&
          attribute.initializer &&
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression
        ) {
          handoff[propName] = expressionReferences(
            attribute.initializer.expression,
          );
        }
      }
      handoffs.push(handoff);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const exactHandoffs = handoffs.filter(
    (handoff) => JSON.stringify(handoff) === JSON.stringify(expected),
  );
  expect(
    exactHandoffs,
    `${componentName} must receive the derived envelope fields exactly once`,
  ).toHaveLength(1);
}

function calledIdentifiers(node: ts.Node): string[] {
  const calls = new Set<string>();
  function visit(current: ts.Node): void {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      calls.add(current.expression.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return [...calls].sort();
}

function namedVariable(
  root: ts.Node,
  variableName: string,
): ts.VariableDeclaration {
  const matches: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  expect(
    matches,
    `${variableName} must have exactly one declaration`,
  ).toHaveLength(1);
  return matches[0];
}

function assertBatchSchemaReferencesSingleShape(path: string): void {
  const file = parse(path);
  const declaration = namedVariable(file, "derivedBatchResponse");
  expect(declaration.initializer).toBeDefined();

  const metricsProperties: ts.PropertyAssignment[] = [];
  function findMetrics(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name, file) === "metrics"
    ) {
      metricsProperties.push(node);
      return;
    }
    ts.forEachChild(node, findMetrics);
  }
  findMetrics(declaration.initializer!);
  expect(
    metricsProperties,
    "derivedBatchResponse must declare exactly one metrics property",
  ).toHaveLength(1);

  const recordCalls: ts.CallExpression[] = [];
  function findRecord(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.expression.name.text === "record"
    ) {
      recordCalls.push(node);
    }
    ts.forEachChild(node, findRecord);
  }
  findRecord(metricsProperties[0].initializer);
  expect(
    recordCalls,
    "derivedBatchResponse.metrics must contain one record value schema",
  ).toHaveLength(1);
  const record = recordCalls[0];
  expect(
    record.arguments.length === 2 &&
      ts.isIdentifier(record.arguments[1]) &&
      record.arguments[1].text === "derivedMetricResponse",
    "derivedBatchResponse.metrics values must use derivedMetricResponse",
  ).toBe(true);
}

function assertBatchProducerLineage(
  path: string,
  responseFields: readonly string[],
): void {
  const file = parse(path);
  const build = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "buildDerivedBatch",
  );
  expect(
    build?.body,
    "buildDerivedBatch must remain a declared function",
  ).toBeDefined();

  const payloads: ts.ObjectLiteralExpression[] = [];
  let mapAssignment = false;
  let returnsMap = false;
  function visitBuild(node: ts.Node): void {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name, file) === "payload"
    ) {
      expect(
        ts.isObjectLiteralExpression(node.initializer),
        "buildDerivedBatch payload must remain an object literal",
      ).toBe(true);
      if (ts.isObjectLiteralExpression(node.initializer)) {
        payloads.push(node.initializer);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "map" &&
      node.left.argumentExpression !== undefined &&
      expressionAccessPath(node.left.argumentExpression) === "r.key" &&
      expressionAccessPath(node.right) === "r.payload"
    ) {
      mapAssignment = true;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "map"
    ) {
      returnsMap = true;
    }
    ts.forEachChild(node, visitBuild);
  }
  visitBuild(build!.body!);
  expect(
    payloads,
    "buildDerivedBatch must construct one metric payload",
  ).toHaveLength(1);
  const payload = payloads[0];
  const lineage: Record<string, string[]> = {};
  for (const property of payload.properties) {
    expect(
      ts.isPropertyAssignment(property),
      `batch payload contains unsupported syntax: ${property.getText(file)}`,
    ).toBe(true);
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name, file);
    expect(name, "batch payload has a computed field").not.toBeNull();
    if (name !== null) {
      lineage[name] = expressionReferences(property.initializer);
    }
  }
  expect(Object.keys(lineage).sort()).toEqual([...responseFields].sort());
  expect(lineage).toEqual({
    metric: ["item.metric"],
    status: ["derived.status"],
    value: ["derived.status", "derived.value"],
    coverage: ["derived.coverage"],
    confidence: ["derived.confidence", "derived.status"],
    provenance: ["derived.provenance"],
    reason: ["derived.reason", "derived.status"],
    assessment: ["derived", "item.metric", "safeAssessment"],
  });
  expect(
    mapAssignment,
    "batch payload must be stored under its request token",
  ).toBe(true);
  expect(returnsMap, "buildDerivedBatch must return the populated map").toBe(
    true,
  );

  const handlerMaps: ts.VariableDeclaration[] = [];
  function findHandlerMap(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "map" &&
      node.initializer &&
      calledIdentifiers(node.initializer).includes("cachedSwr")
    ) {
      handlerMaps.push(node);
    }
    ts.forEachChild(node, findHandlerMap);
  }
  findHandlerMap(file);
  expect(
    handlerMaps,
    "route map must have one cachedSwr declaration",
  ).toHaveLength(1);
  expect(
    calledIdentifiers(handlerMaps[0].initializer!),
    "the cached map must build through buildDerivedBatch",
  ).toContain("buildDerivedBatch");

  const gatedMetrics = namedVariable(file, "gatedMetrics");
  expect(
    expressionReferences(gatedMetrics.initializer!),
    "gatedMetrics must filter the built map",
  ).toContain("map");

  const branches = apiSuccessLineageBranches(path);
  expect(branches, "batch route must return one response branch").toEqual([
    { metrics: ["gatedMetrics"] },
  ]);
}

function assertBatchClientHandoff(
  hookPath: string,
  dashboardPath: string,
): void {
  const hook = parse(hookPath);
  const batchFetches: ts.CallExpression[] = [];
  let readFunction: ts.FunctionDeclaration | undefined;
  function visitHook(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "apiGet" &&
      node.arguments[0]?.getText(hook) ===
        "`/api/insights/derived/batch?${params.toString()}`"
    ) {
      batchFetches.push(node);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === "read") {
      expect(
        readFunction,
        "batch selector must have one read function",
      ).toBeUndefined();
      readFunction = node;
    }
    ts.forEachChild(node, visitHook);
  }
  visitHook(hook);
  expect(
    batchFetches,
    "derived batch hook must fetch the batch endpoint exactly once",
  ).toHaveLength(1);
  expect(
    readFunction?.body,
    "batch hook must declare its read selector",
  ).toBeDefined();

  const entry = namedVariable(readFunction!.body!, "entry");
  expect(
    entry.initializer && ts.isElementAccessExpression(entry.initializer),
    "batch read selector must index the response metrics map",
  ).toBe(true);
  if (entry.initializer && ts.isElementAccessExpression(entry.initializer)) {
    expect(expressionAccessPath(entry.initializer.expression)).toBe(
      "query.data.metrics",
    );
    const token = entry.initializer.argumentExpression;
    expect(
      token &&
        ts.isCallExpression(token) &&
        ts.isIdentifier(token.expression) &&
        token.expression.text === "tokenString" &&
        token.arguments.length === 1 &&
        ts.isIdentifier(token.arguments[0]) &&
        token.arguments[0].text === "token",
      "batch read selector must use the requested token",
    ).toBe(true);
  }
  const returnsEntry = readFunction!.body!.statements.some(
    (statement) =>
      ts.isReturnStatement(statement) &&
      statement.expression !== undefined &&
      expressionReferences(statement.expression).includes("entry"),
  );
  expect(
    returnsEntry,
    "batch read selector must return its selected entry",
  ).toBe(true);

  const dashboard = parse(dashboardPath);
  const readHandoffs: ts.VariableDeclaration[] = [];
  function visitDashboard(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "read" &&
      node.initializer &&
      expressionAccessPath(node.initializer) === "batch.read"
    ) {
      readHandoffs.push(node);
    }
    ts.forEachChild(node, visitDashboard);
  }
  visitDashboard(dashboard);
  expect(
    readHandoffs,
    "VitalsDashboard must consume the batch read selector exactly once",
  ).toHaveLength(1);
}

interface ConsumerBinding {
  file: string;
  accesses: readonly string[];
}

const CONSUMERS: Readonly<Record<string, ConsumerBinding>> = {
  status: {
    file: join(DERIVED_COMPONENTS, "vitals-dashboard.tsx"),
    accesses: ["data.status"],
  },
  value: {
    file: join(DERIVED_COMPONENTS, "vitals-dashboard.tsx"),
    accesses: ["data.value"],
  },
  reason: {
    file: join(DERIVED_COMPONENTS, "vitals-dashboard.tsx"),
    accesses: ["data.reason"],
  },
  "coverage.requiredInputs": {
    file: join(DERIVED_COMPONENTS, "coverage-meter.tsx"),
    accesses: ["coverage.requiredInputs"],
  },
  "coverage.presentInputs": {
    file: join(DERIVED_COMPONENTS, "coverage-meter.tsx"),
    accesses: ["coverage.presentInputs"],
  },
  "coverage.historyDays": {
    file: join(DERIVED_COMPONENTS, "coverage-meter.tsx"),
    accesses: ["coverage.historyDays"],
  },
  "coverage.missing": {
    file: join(DERIVED_COMPONENTS, "coverage-meter.tsx"),
    accesses: ["coverage.missing"],
  },
  "confidence.score": {
    file: join(DERIVED_COMPONENTS, "coverage-meter.tsx"),
    accesses: ["confidence.score"],
  },
  "confidence.band": {
    file: join(DERIVED_COMPONENTS, "coverage-meter.tsx"),
    accesses: ["confidence.band"],
  },
  "assessment.text": {
    file: join(DERIVED_COMPONENTS, "composite-score-anatomy.tsx"),
    accesses: ["assessment.text"],
  },
  "assessment.updatedAt": {
    file: join(DERIVED_COMPONENTS, "composite-score-anatomy.tsx"),
    accesses: ["assessment.updatedAt"],
  },
};

const WIRE_ONLY_METRIC =
  "The metric id intentionally tags the public union for programmatic and native callers. The web already keys each read by the requested metric token and does not need the echo.";
const WIRE_ONLY_PROVENANCE =
  "The public response intentionally preserves machine-readable provenance for programmatic and native callers. The web uses curated method and citation copy rather than rendering raw source metadata.";
const WIRE_ONLY_ASSESSMENT_SOURCE =
  "The public response intentionally identifies deterministic versus cached assessment prose for programmatic and native callers. The web presents the prose and timestamp without exposing its implementation source.";

const WIRE_ONLY_AI =
  "The web reads AI availability from the account payload (`ai` on `/api/auth/me`) for every surface at once; the per-response state is for native and programmatic callers that read one route.";

const EXCEPTIONS: Readonly<Record<string, string>> = {
  "ai.available": WIRE_ONLY_AI,
  "ai.reason": WIRE_ONLY_AI,
  "ai.onDeviceAllowed": WIRE_ONLY_AI,
  metric: WIRE_ONLY_METRIC,
  "provenance.inputs": WIRE_ONLY_PROVENANCE,
  "provenance.source": WIRE_ONLY_PROVENANCE,
  "provenance.windowDays": WIRE_ONLY_PROVENANCE,
  "provenance.computedAt": WIRE_ONLY_PROVENANCE,
  "assessment.source": WIRE_ONLY_ASSESSMENT_SOURCE,
};

describe("derived response consumer guard", () => {
  const { leaves, arrays } = zodObjectShape(
    SCHEMA_FILE,
    "derivedMetricResponse",
  );

  it("anchors the guard to the registered single-metric producer", () => {
    assertPathResponseEnvelope(
      PATH_FILE,
      "/api/insights/derived",
      "derivedMetricResponse",
      "DerivedMetricResponseEnvelope",
    );
    assertPathResponseEnvelope(
      PATH_FILE,
      "/api/insights/derived/batch",
      "derivedBatchResponse",
      "DerivedBatchResponseEnvelope",
    );
    expect(leaves.length).toBeGreaterThan(15);
    expect(arrays).toEqual(["coverage.missing", "provenance.inputs"]);
    const responseFields = [
      ...new Set(leaves.map((leaf) => leaf.split(".", 1)[0])),
    ].sort();
    expect(responseFields).toContain("assessment");
    for (const [index, fields] of apiSuccessObjectBranches(
      ROUTE_FILE,
    ).entries()) {
      expect(
        fields.sort(),
        `derived apiSuccess branch ${index + 1} must expose every registered response field`,
      ).toEqual(responseFields);
    }
    const expectedLineage: Record<string, string[]> = {
      metric: ["metric"],
      status: ["derived.status"],
      value: ["derived.status", "derived.value"],
      coverage: ["derived.coverage"],
      confidence: ["derived.confidence", "derived.status"],
      provenance: ["derived.provenance"],
      reason: ["derived.reason", "derived.status"],
      assessment: ["assessment"],
      ai: ["ai"],
    };
    for (const [index, lineage] of apiSuccessLineageBranches(
      ROUTE_FILE,
    ).entries()) {
      expect(
        lineage,
        `derived apiSuccess branch ${index + 1} must preserve producer lineage`,
      ).toEqual(expectedLineage);
    }
    // v1.42 — the single read goes through the derived cache; the value is
    // still the compute's, built inside the cache's builder.
    const derivedProducer = variableCall(ROUTE_FILE, "derived");
    expect(["computeDerivedMetric", "cachedSwr"]).toContain(derivedProducer);
    if (derivedProducer === "cachedSwr") {
      expect(readFileSync(ROUTE_FILE, "utf8")).toMatch(
        /const derived = await cachedSwr\([\s\S]*?computeDerivedMetric\(/,
      );
    }
    expect(variableCall(ROUTE_FILE, "assessment")).toBe(
      "resolveDerivedAssessment",
    );

    const nestedShapes = [
      ["derivedCoverage", DERIVED_TYPES_FILE, "DerivedCoverage"],
      ["derivedConfidence", DERIVED_TYPES_FILE, "DerivedConfidence"],
      ["derivedProvenance", DERIVED_TYPES_FILE, "DerivedProvenance"],
      ["derivedAssessment", ASSESSMENT_TYPES_FILE, "DerivedAssessment"],
    ] as const;
    for (const [schemaName, typeFile, interfaceName] of nestedShapes) {
      expect(
        zodObjectShape(SCHEMA_FILE, schemaName),
        `${schemaName} must match the value object that reaches the route`,
      ).toEqual(interfaceShape(typeFile, interfaceName));
    }

    assertJsxHandoff(
      join(DERIVED_COMPONENTS, "composite-score-anatomy.tsx"),
      "ScoreAnatomyView",
      {
        coverage: ["data.coverage"],
        confidence: ["data.confidence"],
      },
    );
    assertJsxHandoff(
      join(DERIVED_COMPONENTS, "score-anatomy-view.tsx"),
      "CoverageMeter",
      {
        coverage: ["coverage"],
        confidence: ["confidence"],
      },
    );
    assertBatchSchemaReferencesSingleShape(SCHEMA_FILE);
    // `ai` rides the single-metric route only: the batch serves the
    // deterministic assessment and resolves no capability. The schema marks
    // the field optional for exactly this reason.
    const singleRouteOnly = ["ai"];
    assertBatchProducerLineage(
      BATCH_ROUTE_FILE,
      responseFields.filter((field) => !singleRouteOnly.includes(field)),
    );
    assertBatchClientHandoff(DERIVED_BATCH_CLIENT, VITALS_DASHBOARD);
  });

  it("accounts for every meaningful schema leaf without a generic sweep", () => {
    const accounted = [
      ...Object.keys(CONSUMERS),
      ...Object.keys(EXCEPTIONS),
    ].sort();
    expect(
      accounted,
      "every registered derived-response leaf needs an exact consumer or exception",
    ).toEqual(leaves);

    const accessesByFile = new Map<string, Set<string>>();
    for (const [leaf, binding] of Object.entries(CONSUMERS)) {
      const accesses =
        accessesByFile.get(binding.file) ?? executableAccesses(binding.file);
      accessesByFile.set(binding.file, accesses);
      for (const access of binding.accesses) {
        expect(
          accesses.has(access),
          `${leaf} no longer reads ${access} in ${binding.file}`,
        ).toBe(true);
      }
    }
  });

  it("keeps every wire-only exception exact and non-stale", () => {
    for (const [leaf, reason] of Object.entries(EXCEPTIONS)) {
      expect(leaves, `${leaf} is excepted but no longer returned`).toContain(
        leaf,
      );
      expect(reason.length).toBeGreaterThan(60);
    }
  });
});
