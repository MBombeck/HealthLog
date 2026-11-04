/**
 * Per-envelope response/consumer guard for provider-sync and OCR write results.
 *
 * The producer shape comes from the shared response interface, each route's
 * `apiSuccess` object, and the registered OCR Zod schema. Consumers are pinned
 * to the adapter or dialog that owns that envelope. Field names are always
 * route-qualified, so a generic `failed` or `source` read elsewhere cannot
 * satisfy an unrelated response.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const API_ROOT = join(ROOT, "src/app/api");
const WRITTEN_OUTCOME_SCHEMA = join(ROOT, "src/lib/outcome/written-outcome.ts");
const SYNC_CONSUMER = join(
  ROOT,
  "src/components/settings/integrations/sync-outcome.ts",
);
const SYNC_CARD_ROOT = join(ROOT, "src/components/settings/integrations");
const OCR_SCHEMA = join(ROOT, "src/lib/openapi/routes/ocr.ts");
const OCR_CONSUMER = join(ROOT, "src/components/labs/ocr-review-dialog.tsx");
const OCR_ROUTE = join(ROOT, "src/app/api/labs/ocr/commit/route.ts");
const LAB_SERIALISER = join(ROOT, "src/lib/labs/serialise.ts");

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

  function collectBindings(
    pattern: ts.ObjectBindingPattern,
    base: string,
  ): void {
    for (const element of pattern.elements) {
      const key =
        element.propertyName !== undefined
          ? propertyName(element.propertyName, file)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
      if (key === null) continue;
      const access = `${base}.${key}`;
      accesses.add(access);
      if (ts.isObjectBindingPattern(element.name)) {
        collectBindings(element.name, access);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const access = expressionAccessPath(node);
      if (access !== null) accesses.add(access);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const base = expressionAccessPath(node.initializer);
      if (base !== null) collectBindings(node.name, base);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return accesses;
}

function interfaceFields(path: string, interfaceName: string): string[] {
  const file = parse(path);
  const declarations = new Map(
    file.statements.flatMap((statement) =>
      ts.isInterfaceDeclaration(statement)
        ? ([[statement.name.text, statement]] as const)
        : [],
    ),
  );

  function collect(name: string, seen: Set<string>): string[] {
    expect(seen.has(name), `cyclic interface inheritance at ${name}`).toBe(
      false,
    );
    const declaration = declarations.get(name);
    expect(
      declaration,
      `${name} must remain an interface in ${path}`,
    ).toBeDefined();
    const nextSeen = new Set(seen).add(name);
    const inherited = (declaration!.heritageClauses ?? []).flatMap((clause) =>
      clause.types.flatMap((type) =>
        ts.isIdentifier(type.expression)
          ? collect(type.expression.text, nextSeen)
          : [],
      ),
    );
    const own = declaration!.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || member.name === undefined)
        return [];
      const name = propertyName(member.name, file);
      return name === null ? [] : [name];
    });
    return [...new Set([...inherited, ...own])];
  }

  return collect(interfaceName, new Set());
}

interface ApiSuccessBranch {
  fields: string[];
  resolveCalls: number;
}

interface ApiSuccessSpread {
  fields: string[];
  resolveCalls: number;
}

function apiSuccessBranches(
  path: string,
  writtenOutcomeFields: readonly string[],
): ApiSuccessBranch[] {
  const file = parse(path);
  const branches: ApiSuccessBranch[] = [];

  function isWrittenOutcomeCall(
    expression: ts.Expression,
  ): expression is ts.CallExpression {
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "resolveSyncOutcome"
    );
  }

  function inspectObjectLiteralSpread(
    object: ts.ObjectLiteralExpression,
  ): ApiSuccessSpread {
    const fields: string[] = [];
    for (const property of object.properties) {
      expect(
        ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property),
        `${path} has unsupported conditional spread syntax: ${property.getText(file)}`,
      ).toBe(true);
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        continue;
      }
      const name = propertyName(property.name, file);
      expect(name, `${path} has a computed conditional spread field`).not.toBe(
        null,
      );
      if (name !== null) fields.push(name);
    }
    return { fields, resolveCalls: 0 };
  }

  function inspectSpread(expression: ts.Expression): ApiSuccessSpread | null {
    if (isWrittenOutcomeCall(expression)) {
      return { fields: [...writtenOutcomeFields], resolveCalls: 1 };
    }
    if (ts.isParenthesizedExpression(expression)) {
      return inspectSpread(expression.expression);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return inspectObjectLiteralSpread(expression);
    }
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = inspectSpread(expression.whenTrue);
      const whenFalse = inspectSpread(expression.whenFalse);
      if (
        whenTrue === null ||
        whenFalse === null ||
        whenTrue.resolveCalls !== 0 ||
        whenFalse.resolveCalls !== 0
      ) {
        return null;
      }
      return {
        fields: [...new Set([...whenTrue.fields, ...whenFalse.fields])],
        resolveCalls: 0,
      };
    }
    return null;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "apiSuccess"
    ) {
      const fields: string[] = [];
      let resolveCalls = 0;
      const payload = node.arguments[0];
      expect(
        payload,
        `${path} apiSuccess branch must have a payload`,
      ).toBeDefined();

      if (payload && isWrittenOutcomeCall(payload)) {
        resolveCalls += 1;
        fields.push(...writtenOutcomeFields);
      } else if (payload && ts.isObjectLiteralExpression(payload)) {
        for (const property of payload.properties) {
          if (ts.isSpreadAssignment(property)) {
            const spread = inspectSpread(property.expression);
            expect(
              spread,
              `${path} has an unsupported apiSuccess spread: ${property.getText(file)}`,
            ).not.toBeNull();
            if (spread !== null) {
              for (const name of spread.fields) {
                if (resolveCalls > 0) {
                  expect(
                    writtenOutcomeFields,
                    `${path} overrides ${name} after resolveSyncOutcome(...)`,
                  ).not.toContain(name);
                }
                fields.push(name);
              }
              resolveCalls += spread.resolveCalls;
            }
            continue;
          }
          expect(
            ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property),
            `${path} has unsupported apiSuccess object syntax: ${property.getText(file)}`,
          ).toBe(true);
          if (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
          ) {
            const name = propertyName(property.name, file);
            expect(
              name,
              `${path} has a computed response field`,
            ).not.toBeNull();
            if (resolveCalls > 0 && name !== null) {
              expect(
                writtenOutcomeFields,
                `${path} overrides ${name} after resolveSyncOutcome(...)`,
              ).not.toContain(name);
            }
            if (name !== null) fields.push(name);
          }
        }
      } else if (payload) {
        expect(
          false,
          `${path} has an unsupported apiSuccess payload: ${payload.getText(file)}`,
        ).toBe(true);
      }

      branches.push({
        fields: [...new Set(fields)],
        resolveCalls,
      });
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

function objectLiteralFields(
  object: ts.ObjectLiteralExpression,
  file: ts.SourceFile,
  context: string,
): string[] {
  return object.properties.flatMap((property) => {
    expect(
      ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property),
      `${context} contains unsupported object syntax: ${property.getText(file)}`,
    ).toBe(true);
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      return [];
    }
    const name = propertyName(property.name, file);
    expect(name, `${context} has a computed field`).not.toBeNull();
    return name === null ? [] : [name];
  });
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
        branches.push(
          objectLiteralFields(payload, file, `${path} apiSuccess payload`),
        );
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

function functionReturnObjectBranches(
  path: string,
  functionName: string,
): string[][] {
  const file = parse(path);
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  expect(
    declaration?.body,
    `${functionName} must remain a declared function with a body`,
  ).toBeDefined();
  const branches: string[][] = [];
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node)) {
      expect(
        node.expression && ts.isObjectLiteralExpression(node.expression),
        `${functionName} return must remain an object literal`,
      ).toBe(true);
      if (node.expression && ts.isObjectLiteralExpression(node.expression)) {
        branches.push(
          objectLiteralFields(
            node.expression,
            file,
            `${functionName} return payload`,
          ),
        );
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration!.body!);
  expect(
    branches.length,
    `${functionName} must return a payload`,
  ).toBeGreaterThan(0);
  return branches;
}

function pushedObjectBranches(path: string, receiver: string): string[][] {
  const file = parse(path);
  const branches: string[][] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === receiver &&
      node.expression.name.text === "push"
    ) {
      const payload = node.arguments[0];
      expect(
        payload && ts.isObjectLiteralExpression(payload),
        `${receiver}.push payload must remain an object literal`,
      ).toBe(true);
      if (payload && ts.isObjectLiteralExpression(payload)) {
        branches.push(
          objectLiteralFields(payload, file, `${receiver}.push payload`),
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(
    branches.length,
    `${path} must still populate ${receiver}`,
  ).toBeGreaterThan(0);
  return branches;
}

function assertPushCallsUse(
  path: string,
  receiver: string,
  callee: string,
): void {
  const file = parse(path);
  let calls = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === receiver &&
      node.expression.name.text === "push"
    ) {
      calls += 1;
      const payload = node.arguments[0];
      expect(
        payload &&
          ts.isCallExpression(payload) &&
          ts.isIdentifier(payload.expression) &&
          payload.expression.text === callee,
        `${receiver}.push must receive ${callee}(...)`,
      ).toBe(true);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(calls, `${path} must still populate ${receiver}`).toBeGreaterThan(0);
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
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        initializers.set(declaration.name.text, declaration.initializer);
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
      // The shared instant helper (`@/lib/validations/datetime`) is a leaf.
      if (ts.isIdentifier(callee) && callee.text === "isoDateTime") {
        return [prefix];
      }
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
            const name = propertyName(property.name, file);
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

type SyncResponseClass = "resolved" | "resolved-with-full-sync-echo";

interface SyncRouteSpec {
  id: string;
  path: string;
  responseClass: SyncResponseClass;
  exceptions: Readonly<Record<string, string>>;
  card: string;
}

const FULL_SYNC_EXCEPTION =
  "The boolean intentionally echoes the requested sync mode for programmatic callers; the web card already owns that mode as request state and does not read the echo.";
const GOOGLE_HEALTH_RESOURCES_EXCEPTION =
  "The bounded resource array is consumed by both readSyncOutcome and readGoogleHealthProgress so partial writes, actionable failures, and workout cache invalidation survive the response boundary.";
const GOOGLE_HEALTH_STATE_EXCEPTION =
  "The bounded terminal state is consumed by readGoogleHealthProgress and drives the Google Health card's complete, partial, truncated, interrupted, and failed presentation.";
const GOOGLE_HEALTH_RUN_ID_EXCEPTION =
  "The bounded opaque run identifier is a wire-level correlation token for programmatic callers and the status endpoint; the web card does not render or persist it.";

const SYNC_ROUTES: readonly SyncRouteSpec[] = [
  {
    id: "fitbit",
    path: join(ROOT, "src/app/api/fitbit/sync/route.ts"),
    responseClass: "resolved-with-full-sync-echo",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: { fullSync: FULL_SYNC_EXCEPTION },
  },
  {
    id: "google-health",
    path: join(ROOT, "src/app/api/google-health/sync/route.ts"),
    responseClass: "resolved-with-full-sync-echo",
    card: join(SYNC_CARD_ROOT, "google-health-card.tsx"),
    exceptions: {
      fullSync: FULL_SYNC_EXCEPTION,
      resources: GOOGLE_HEALTH_RESOURCES_EXCEPTION,
      runId: GOOGLE_HEALTH_RUN_ID_EXCEPTION,
      state: GOOGLE_HEALTH_STATE_EXCEPTION,
    },
  },
  {
    id: "garmin",
    path: join(ROOT, "src/app/api/garmin/sync/route.ts"),
    responseClass: "resolved",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: {},
  },
  {
    id: "nightscout",
    path: join(ROOT, "src/app/api/nightscout/sync/route.ts"),
    responseClass: "resolved",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: {},
  },
  {
    id: "oura",
    path: join(ROOT, "src/app/api/oura/sync/route.ts"),
    responseClass: "resolved",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: {},
  },
  {
    id: "polar",
    path: join(ROOT, "src/app/api/polar/sync/route.ts"),
    responseClass: "resolved",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: {},
  },
  {
    id: "strava",
    path: join(ROOT, "src/app/api/strava/sync/route.ts"),
    responseClass: "resolved",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: {},
  },
  {
    id: "whoop",
    path: join(ROOT, "src/app/api/whoop/sync/route.ts"),
    responseClass: "resolved-with-full-sync-echo",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: { fullSync: FULL_SYNC_EXCEPTION },
  },
  {
    id: "withings",
    path: join(ROOT, "src/app/api/withings/sync/route.ts"),
    responseClass: "resolved-with-full-sync-echo",
    card: join(SYNC_CARD_ROOT, "integration-actions.tsx"),
    exceptions: { fullSync: FULL_SYNC_EXCEPTION },
  },
] as const;

const SYNC_CONSUMER_ACCESS: Readonly<Record<string, readonly string[]>> = {
  imported: ["data.imported"],
  failed: ["data.failed"],
  outcome: ["data.outcome", "result.outcome"],
};

const OCR_ROW_EXCEPTION =
  "The web dialog intentionally consumes the collection count only, then invalidates the labs queries. The full committed-row DTO remains on the response for non-web API callers.";
const OCR_SKIP_EXCEPTION =
  "The web dialog intentionally consumes the skipped collection count only. Per-row duplicate detail remains on the response for non-web API callers.";

const OCR_EXCEPTIONS: Readonly<Record<string, string>> = {
  "inserted.id": OCR_ROW_EXCEPTION,
  "inserted.biomarkerId": OCR_ROW_EXCEPTION,
  "inserted.panel": OCR_ROW_EXCEPTION,
  "inserted.analyte": OCR_ROW_EXCEPTION,
  "inserted.value": OCR_ROW_EXCEPTION,
  "inserted.valueText": OCR_ROW_EXCEPTION,
  "inserted.unit": OCR_ROW_EXCEPTION,
  "inserted.converted": OCR_ROW_EXCEPTION,
  "inserted.sourceValue": OCR_ROW_EXCEPTION,
  "inserted.sourceUnit": OCR_ROW_EXCEPTION,
  "inserted.referenceLow": OCR_ROW_EXCEPTION,
  "inserted.referenceHigh": OCR_ROW_EXCEPTION,
  "inserted.catalogReferenceLow": OCR_ROW_EXCEPTION,
  "inserted.catalogReferenceHigh": OCR_ROW_EXCEPTION,
  "inserted.sourceReferenceLow": OCR_ROW_EXCEPTION,
  "inserted.sourceReferenceHigh": OCR_ROW_EXCEPTION,
  "inserted.sourceReferenceText": OCR_ROW_EXCEPTION,
  "inserted.printedReferenceText": OCR_ROW_EXCEPTION,
  "inserted.referenceOrigin": OCR_ROW_EXCEPTION,
  "inserted.referenceDivergesFromCatalog": OCR_ROW_EXCEPTION,
  "inserted.takenAt": OCR_ROW_EXCEPTION,
  "inserted.source": OCR_ROW_EXCEPTION,
  "inserted.hasNote": OCR_ROW_EXCEPTION,
  "inserted.rangeStatus": OCR_ROW_EXCEPTION,
  "inserted.createdAt": OCR_ROW_EXCEPTION,
  "inserted.updatedAt": OCR_ROW_EXCEPTION,
  "skipped.analyte": OCR_SKIP_EXCEPTION,
  "skipped.reason": OCR_SKIP_EXCEPTION,
};

const OCR_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  outcome: ["result.outcome"],
};

const OCR_COLLECTION_CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  inserted: ["result.inserted.length"],
  skipped: ["result.skipped.length"],
};

/**
 * `/api/<provider>/sync` routes that only queue a background job and answer
 * 202 `{ enqueued }`: nothing is written while the request runs, so there is
 * no written outcome to resolve. Each entry says why.
 */
const QUEUE_ONLY_SYNC_ROUTES: Readonly<Record<string, string>> = {
  dawarich:
    "Dawarich daily values are fetched by the dawarich-sync job; the route answers 202 { enqueued } and the outcome reaches the card through the connection health, not this response.",
};

function discoveredSyncRoutes(): Array<{ id: string; path: string }> {
  return readdirSync(API_ROOT, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    if (entry.name in QUEUE_ONLY_SYNC_ROUTES) return [];
    const path = join(API_ROOT, entry.name, "sync", "route.ts");
    return existsSync(path) ? [{ id: entry.name, path }] : [];
  });
}

function directVariableDeclarations(block: ts.Block): ts.VariableDeclaration[] {
  return block.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations]
      : [],
  );
}

function containsNode(root: ts.Node, target: ts.Node): boolean {
  if (root === target) return true;
  let found = false;
  ts.forEachChild(root, (child) => {
    if (!found && containsNode(child, target)) found = true;
  });
  return found;
}

function objectPropertyInitializer(
  object: ts.ObjectLiteralExpression,
  name: string,
  file: ts.SourceFile,
): ts.Expression | null {
  const property = object.properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name, file) === name,
  );
  return property && ts.isPropertyAssignment(property)
    ? property.initializer
    : null;
}

function jsxAttributePath(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): string | null {
  const attribute = node.attributes.properties.find(
    (candidate) =>
      ts.isJsxAttribute(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name,
  );
  if (
    !attribute ||
    !ts.isJsxAttribute(attribute) ||
    !attribute.initializer ||
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  ) {
    return null;
  }
  return expressionAccessPath(attribute.initializer.expression);
}

function assertSyncCardConsumesFetchedResponse(
  path: string,
  routeId: string,
): void {
  const file = parse(path);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "readSyncOutcome"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(calls, `${path} must call readSyncOutcome exactly once`).toHaveLength(
    1,
  );
  const call = calls[0];
  expect(
    call.arguments.length === 1 && ts.isIdentifier(call.arguments[0]),
    `${path} must pass one fetched response value to readSyncOutcome`,
  ).toBe(true);
  if (call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]))
    return;
  const responseValue = call.arguments[0].text;

  let block: ts.Node | undefined = call.parent;
  while (block && !ts.isBlock(block)) block = block.parent;
  expect(
    block,
    `${path} readSyncOutcome call must live in a block`,
  ).toBeDefined();
  if (!block || !ts.isBlock(block)) return;
  const declarations = directVariableDeclarations(block);
  const jsonDeclaration = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === responseValue,
  );
  expect(
    jsonDeclaration?.initializer,
    `${path} must bind the readSyncOutcome argument from response.json()`,
  ).toBeDefined();
  if (!jsonDeclaration?.initializer) return;
  let jsonInitializer = jsonDeclaration.initializer;
  if (ts.isAwaitExpression(jsonInitializer))
    jsonInitializer = jsonInitializer.expression;
  expect(
    ts.isCallExpression(jsonInitializer) &&
      ts.isPropertyAccessExpression(jsonInitializer.expression) &&
      jsonInitializer.expression.name.text === "json" &&
      ts.isIdentifier(jsonInitializer.expression.expression),
    `${path} must bind the adapter input from response.json()`,
  ).toBe(true);
  if (
    !ts.isCallExpression(jsonInitializer) ||
    !ts.isPropertyAccessExpression(jsonInitializer.expression) ||
    !ts.isIdentifier(jsonInitializer.expression.expression)
  ) {
    return;
  }

  const responseName = jsonInitializer.expression.expression.text;
  const responseDeclaration = declarations.find(
    (declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === responseName,
  );
  expect(
    responseDeclaration?.initializer,
    `${path} must bind ${responseName} from apiFetchRaw`,
  ).toBeDefined();
  if (!responseDeclaration?.initializer) return;
  let responseInitializer = responseDeclaration.initializer;
  if (ts.isAwaitExpression(responseInitializer))
    responseInitializer = responseInitializer.expression;
  expect(
    ts.isCallExpression(responseInitializer) &&
      ts.isIdentifier(responseInitializer.expression) &&
      responseInitializer.expression.text === "apiFetchRaw",
    `${path} must read the sync response returned by apiFetchRaw`,
  ).toBe(true);
  if (
    !ts.isCallExpression(responseInitializer) ||
    responseInitializer.arguments.length === 0
  ) {
    return;
  }
  const endpoint = responseInitializer.arguments[0];
  const expectedEndpoint = path.endsWith("integration-actions.tsx")
    ? "`/api/${provider}/sync`"
    : `"/api/${routeId}/sync"`;
  expect(
    endpoint.getText(file),
    `${path} must feed the ${routeId} sync response to readSyncOutcome`,
  ).toBe(expectedEndpoint);

  const resultDeclarations = declarations.filter(
    (declaration) =>
      declaration.initializer && containsNode(declaration.initializer, call),
  );
  expect(
    resultDeclarations,
    `${path} must bind readSyncOutcome(...) to one result variable`,
  ).toHaveLength(1);
  const resultDeclaration = resultDeclarations[0];
  expect(
    ts.isIdentifier(resultDeclaration.name),
    `${path} adapter result must use an identifier`,
  ).toBe(true);
  if (!ts.isIdentifier(resultDeclaration.name)) return;
  const resultName = resultDeclaration.name.text;
  expect(
    resultDeclaration.initializer &&
      ts.isConditionalExpression(resultDeclaration.initializer) &&
      expressionAccessPath(resultDeclaration.initializer.condition) ===
        `${responseName}.ok` &&
      resultDeclaration.initializer.whenTrue === call &&
      resultDeclaration.initializer.whenFalse.kind ===
        ts.SyntaxKind.NullKeyword,
    `${path} result must be the adapter value gated only by the fetched response status`,
  ).toBe(true);

  let successWrites = 0;
  let renderedStates = 0;
  function traceState(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "setSyncResult" &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const state = node.arguments[0];
      const outcome = objectPropertyInitializer(state, "outcome", file);
      const message = objectPropertyInitializer(state, "message", file);
      const messageUsesResult =
        message !== null &&
        ts.isCallExpression(message) &&
        ts.isIdentifier(message.expression) &&
        message.expression.text === "describeSyncOutcome" &&
        message.arguments.length >= 1 &&
        ts.isIdentifier(message.arguments[0]) &&
        message.arguments[0].text === resultName;
      if (
        outcome !== null &&
        expressionAccessPath(outcome) === `${resultName}.outcome` &&
        messageUsesResult
      ) {
        successWrites += 1;
      }
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === "WrittenOutcomeLine" &&
      jsxAttributePath(node, "outcome") === "syncResult.outcome" &&
      jsxAttributePath(node, "message") === "syncResult.message"
    ) {
      renderedStates += 1;
    }
    ts.forEachChild(node, traceState);
  }
  traceState(file);
  expect(
    successWrites,
    `${path} must store the adapter result outcome and described message exactly once`,
  ).toBe(1);
  expect(
    renderedStates,
    `${path} must render the stored outcome and message exactly once`,
  ).toBe(1);
}

function assertOcrOutcomeClassifier(path: string): void {
  const file = parse(path);
  let branches = 0;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "apiSuccess"
    ) {
      const payload = node.arguments[0];
      expect(
        payload && ts.isObjectLiteralExpression(payload),
        "OCR apiSuccess payload must remain an object literal",
      ).toBe(true);
      if (!payload || !ts.isObjectLiteralExpression(payload)) return;
      branches += 1;
      const outcome = payload.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name, file) === "outcome",
      );
      expect(
        outcome && ts.isPropertyAssignment(outcome),
        "OCR response must expose outcome",
      ).toBe(true);
      if (!outcome || !ts.isPropertyAssignment(outcome)) return;
      expect(
        ts.isCallExpression(outcome.initializer) &&
          ts.isIdentifier(outcome.initializer.expression) &&
          outcome.initializer.expression.text === "classifyWrittenOutcome",
        "OCR outcome must come from classifyWrittenOutcome(...)",
      ).toBe(true);
      if (
        !ts.isCallExpression(outcome.initializer) ||
        outcome.initializer.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(outcome.initializer.arguments[0])
      ) {
        return;
      }
      const counts = outcome.initializer.arguments[0].properties.flatMap(
        (property) => {
          expect(
            ts.isPropertyAssignment(property),
            "OCR classifier counts must use explicit object properties",
          ).toBe(true);
          if (!ts.isPropertyAssignment(property)) return [];
          const name = propertyName(property.name, file);
          const access = expressionAccessPath(property.initializer);
          return name === null || access === null
            ? []
            : [[name, access] as const];
        },
      );
      expect(counts.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
        ["skipped", "skipped.length"],
        ["written", "inserted.length"],
      ]);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(branches).toBeGreaterThan(0);
}

describe("written-outcome response consumer guard", () => {
  it("pairs every provider sync response leaf with its adapter or exact exception", () => {
    const sharedFields = interfaceFields(
      WRITTEN_OUTCOME_SCHEMA,
      "ResolvedSyncOutcome",
    );
    expect(
      sharedFields,
      "a new shared sync-response field needs an explicit adapter read",
    ).toEqual(["imported", "failed", "outcome"]);

    const consumerAccesses = executableAccesses(SYNC_CONSUMER);
    expect(Object.keys(SYNC_CONSUMER_ACCESS)).toEqual(sharedFields);
    for (const field of sharedFields) {
      for (const access of SYNC_CONSUMER_ACCESS[field]) {
        expect(
          consumerAccesses.has(access),
          `${field} no longer reads ${access} in the sync outcome adapter`,
        ).toBe(true);
      }
    }
    for (const [id, reason] of Object.entries(QUEUE_ONLY_SYNC_ROUTES)) {
      expect(
        existsSync(join(API_ROOT, id, "sync", "route.ts")),
        `${id} is listed as a queue-only sync route but has none`,
      ).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
    const discovered = discoveredSyncRoutes().sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const specified = SYNC_ROUTES.map(({ id, path }) => ({ id, path })).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    expect(
      specified,
      "every provider sync route needs an explicit response classification",
    ).toEqual(discovered);

    for (const route of SYNC_ROUTES) {
      const branches = apiSuccessBranches(route.path, sharedFields);
      for (const [index, branch] of branches.entries()) {
        expect(
          branch.resolveCalls,
          `${route.id} apiSuccess branch ${index + 1} must return resolveSyncOutcome(...) exactly once`,
        ).toBe(1);
        for (const field of sharedFields) {
          expect(
            branch.fields,
            `${route.id} apiSuccess branch ${index + 1} dropped ${field}`,
          ).toContain(field);
        }
        const extras = branch.fields.filter(
          (field) => !sharedFields.includes(field),
        );
        const classifiedExtras = Object.keys(route.exceptions);
        expect(
          extras.sort(),
          `${route.id} branch ${index + 1} must match its response classification`,
        ).toEqual(classifiedExtras.sort());
        if (route.responseClass === "resolved-with-full-sync-echo") {
          expect(extras).toContain("fullSync");
        } else {
          expect(extras).not.toContain("fullSync");
        }
        for (const field of extras) {
          expect(route.exceptions[field].length).toBeGreaterThan(40);
        }
      }
      assertSyncCardConsumesFetchedResponse(route.card, route.id);
    }
  });

  it("pairs every OCR commit response leaf with the dialog or an exact wire-only exception", () => {
    const { leaves, arrays } = zodObjectShape(OCR_SCHEMA, "commitResponse");
    const registry = source(OCR_SCHEMA);
    expect(registry).toMatch(
      /"\/api\/labs\/ocr\/commit":\s*\{[\s\S]*?"200":\s*\{[\s\S]*?schema:\s*dataEnvelope\(\s*commitResponse,\s*"OcrCommitEnvelope"/,
    );
    expect(arrays).toEqual(["inserted", "skipped"]);
    expect(Object.keys(OCR_COLLECTION_CONSUMERS).sort()).toEqual(arrays);
    const responseFields = [
      ...new Set(leaves.map((leaf) => leaf.split(".", 1)[0])),
    ].sort();
    for (const [index, fields] of apiSuccessObjectBranches(
      OCR_ROUTE,
    ).entries()) {
      expect(
        fields.sort(),
        `OCR apiSuccess branch ${index + 1} must expose every registered response field`,
      ).toEqual(responseFields);
    }
    assertOcrOutcomeClassifier(OCR_ROUTE);

    const insertedFields = leaves
      .filter((leaf) => leaf.startsWith("inserted."))
      .map((leaf) => leaf.slice("inserted.".length))
      .sort();
    for (const [index, fields] of functionReturnObjectBranches(
      LAB_SERIALISER,
      "serialiseLabResult",
    ).entries()) {
      expect(
        fields.sort(),
        `serialiseLabResult branch ${index + 1} must populate every inserted-row field`,
      ).toEqual(insertedFields);
    }
    assertPushCallsUse(OCR_ROUTE, "inserted", "serialiseLabResult");

    const skippedFields = leaves
      .filter((leaf) => leaf.startsWith("skipped."))
      .map((leaf) => leaf.slice("skipped.".length))
      .sort();
    for (const [index, fields] of pushedObjectBranches(
      OCR_ROUTE,
      "skipped",
    ).entries()) {
      expect(
        fields.sort(),
        `skipped.push branch ${index + 1} must populate every skipped-row field`,
      ).toEqual(skippedFields);
    }
    const accounted = [
      ...Object.keys(OCR_CONSUMERS),
      ...Object.keys(OCR_EXCEPTIONS),
    ].sort();
    expect(
      accounted,
      "the OCR response maps must exactly cover the registered producer schema",
    ).toEqual(leaves);

    const consumerAccesses = executableAccesses(OCR_CONSUMER);
    for (const [leaf, accesses] of Object.entries(OCR_CONSUMERS)) {
      for (const access of accesses) {
        expect(
          consumerAccesses.has(access),
          `${leaf} no longer reads ${access} in the OCR dialog`,
        ).toBe(true);
      }
    }
    for (const [collection, accesses] of Object.entries(
      OCR_COLLECTION_CONSUMERS,
    )) {
      for (const access of accesses) {
        expect(
          consumerAccesses.has(access),
          `${collection}.length no longer reads ${access} in the OCR dialog`,
        ).toBe(true);
      }
    }
    for (const [leaf, reason] of Object.entries(OCR_EXCEPTIONS)) {
      expect(leaves, `${leaf} is excepted but no longer returned`).toContain(
        leaf,
      );
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
