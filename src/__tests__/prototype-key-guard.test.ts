/**
 * Text from outside never indexes a plain object.
 *
 * A FHIR import crashed on an Observation whose LOINC code was `"__proto__"`:
 * the vital-sign table is a plain object, `VITAL_LOINC["__proto__"]` is
 * `Object.prototype`, and its `units` read off as `undefined`. The same shape
 * sat in the Health Connect import, where a package name of `"__proto__"`
 * made `(perApp[pkg] ??= { records: 0 }).records += n` write a `records`
 * property onto `Object.prototype` for the whole worker process.
 *
 * The rule, in the directories that read files, request bodies and queries,
 * stored preferences and third-party payloads: an element access whose key is
 * typed as open text (`string`, not a closed union of literals) on a plain
 * object or record is a finding. The fixes are in `src/lib/own-key.ts`:
 * `ownValue` / `hasOwnKey` for a fixed table, `ownRecord()` (no prototype)
 * or a `Map` for a map built at run time. An access on a binding initialised
 * with `ownRecord()` or `Object.create(null)` passes. So does `key in obj`
 * only when `obj` is such a binding.
 *
 * The check runs the type checker, because whether a key is open text is a
 * type question: `TABLE[row.type]` with a Prisma enum key is closed and
 * fine, `TABLE[code]` with a string from a file is not, and the two read the
 * same. `ALLOWED` lists the few accesses that stay plain, keyed by file and
 * expression, each with its reason; a stale entry fails, and so does an
 * entry the sweep would not have flagged.
 */
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import { requireFloor, walkSourceFiles } from "./helpers/source-files";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Where outside text is parsed, mapped or stored. Paths under `src/`. */
const SCOPE = [
  "app/api/",
  "lib/apple-health/",
  "lib/auth/",
  "lib/cycle/",
  "lib/documents/",
  "lib/export/",
  "lib/export.ts",
  "lib/fhir/",
  "lib/fit/",
  "lib/garmin/",
  "lib/google-health/",
  "lib/idempotency.ts",
  "lib/import/",
  "lib/labs/",
  "lib/mcp/",
  "lib/measurements/",
  "lib/modules/",
  "lib/mood/",
  "lib/multipart/",
  "lib/nutrients/",
  "lib/observability/",
  "lib/oura/",
  "lib/polar/",
  "lib/profile/",
  "lib/record-settings/",
  "lib/settings/",
  "lib/strava/",
  "lib/validations/",
  "lib/whoop/",
  "lib/withings/",
  "lib/workouts/",
];

/**
 * Accesses that stay plain, as `<file under src>::<expression>`. The object
 * is not a lookup table, or the key never comes from outside and the object
 * has no own entry to find.
 */
const ALLOWED: Record<string, string> = {
  "lib/export/restore-target.ts::(db as Record<string, OwnedDelegate | undefined>)[key]":
    "A Prisma model delegate, looked up by a model name from the closed restore plan; the client serves delegates through its own accessors, so an own-key read would find none.",
  "lib/auth/session-lifetime.ts::env[setting.name]":
    "An environment read whose name comes from the three DaysSetting constants in the same file, never from input.",
};

function inScope(rel: string): boolean {
  if (/(^|\/)__tests__\/|\.test\.tsx?$|\.browser\.test\./.test(rel)) {
    return false;
  }
  return SCOPE.some((s) => (s.endsWith("/") ? rel.startsWith(s) : rel === s));
}

interface Finding {
  key: string;
  line: number;
}

/**
 * A file the sweep must flag exactly where the comments say, served from
 * memory beside the real ones so a matcher that drifts goes red here rather
 * than turning the sweep into one that finds nothing.
 */
const PROBE = join(SRC, "lib/import/__prototype_key_probe__.ts");
const PROBE_TEXT = `
import { ownRecord, ownValue } from "@/lib/own-key";
type Kind = "a" | "b";
const TABLE: Record<string, { n: number }> = { a: { n: 1 } };
const CLOSED: Record<Kind, number> = { a: 1, b: 2 };
export function probe(code: string, kind: Kind) {
  const counts: Record<string, number> = {};
  counts[code] = 1; // flagged: write
  const safe = ownRecord<number>();
  safe[code] = 1;
  return [
    TABLE[code], // flagged: read
    code in TABLE, // flagged: in
    ownValue(TABLE, code),
    TABLE["a"],
    CLOSED[kind],
    process.env[code],
    safe[code],
    code in safe,
  ];
}
`;
const PROBE_EXPECTED = [
  "lib/import/__prototype_key_probe__.ts::counts[code]",
  "lib/import/__prototype_key_probe__.ts::TABLE[code]",
  "lib/import/__prototype_key_probe__.ts::code in TABLE",
];

function sweep(): { findings: Finding[]; files: number } {
  const files = walkSourceFiles(SRC, { floor: 1000 })
    .filter(inScope)
    .map((rel) => join(SRC, rel));
  requireFloor("prototype-key guard scope", files, 400);
  files.push(PROBE);

  const config = ts.readConfigFile(
    join(ROOT, "tsconfig.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, version, ...rest) =>
    resolve(name) === PROBE
      ? ts.createSourceFile(name, PROBE_TEXT, version)
      : getSourceFile(name, version, ...rest);
  host.fileExists = (name) => resolve(name) === PROBE || fileExists(name);
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const wanted = new Set(files);
  const findings: Finding[] = [];

  const isOpenText = (t: ts.Type): boolean =>
    t.isUnion()
      ? t.types.some(isOpenText)
      : (t.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) !== 0;

  const NOT_PLAIN = new Set([
    "Map",
    "ReadonlyMap",
    "Set",
    "Array",
    "ReadonlyArray",
    "URLSearchParams",
    "Headers",
    "FormData",
  ]);
  const isPlainObject = (t: ts.Type): boolean => {
    if (t.isUnion()) {
      return t.types.some(
        (x) =>
          (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0 &&
          isPlainObject(x),
      );
    }
    const name = t.getSymbol()?.getName();
    if (name && NOT_PLAIN.has(name)) return false;
    if (checker.isArrayType(t) || checker.isTupleType(t)) return false;
    return (t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Any)) !== 0;
  };

  /** Typed `OwnRecord<V>` (`src/lib/own-key.ts`), branded in the type only. */
  const isOwnRecordType = (t: ts.Type): boolean =>
    t.isUnion()
      ? t.types.every(
          (x) =>
            (x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0 ||
            isOwnRecordType(x),
        )
      : checker
          .getPropertiesOfType(t)
          .some((p) => String(p.escapedName).startsWith("__@OWN_RECORD@"));

  /** The binding was created without a prototype. */
  const isOwnRecordBinding = (expr: ts.Expression): boolean => {
    if (isOwnRecordType(checker.getTypeAtLocation(expr))) return true;
    const target = ts.isNonNullExpression(expr) ? expr.expression : expr;
    const node = ts.isPropertyAccessExpression(target) ? target.name : target;
    const symbol = checker.getSymbolAtLocation(node);
    const decl = symbol?.valueDeclaration;
    if (
      !decl ||
      !(
        ts.isVariableDeclaration(decl) ||
        ts.isPropertyDeclaration(decl) ||
        ts.isPropertyAssignment(decl)
      ) ||
      !decl.initializer
    ) {
      return false;
    }
    let init: ts.Expression = decl.initializer;
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) {
      init = init.expression;
    }
    if (!ts.isCallExpression(init)) return false;
    const callee = init.expression.getText();
    return (
      callee === "ownRecord" ||
      (callee === "Object.create" &&
        init.arguments[0]?.kind === ts.SyntaxKind.NullKeyword)
    );
  };

  for (const sf of program.getSourceFiles()) {
    if (!wanted.has(sf.fileName)) continue;
    const rel = relative(SRC, sf.fileName).split(sep).join("/");
    const record = (node: ts.Node) => {
      const text = node.getText(sf).replace(/\s+/g, " ");
      findings.push({
        key: `${rel}::${text}`,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node)) {
        const arg = node.argumentExpression;
        if (
          node.expression.getText(sf) !== "process.env" &&
          !ts.isStringLiteralLike(arg) &&
          !ts.isNumericLiteral(arg) &&
          isOpenText(checker.getTypeAtLocation(arg)) &&
          isPlainObject(checker.getTypeAtLocation(node.expression)) &&
          !isOwnRecordBinding(node.expression)
        ) {
          record(node);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        isOpenText(checker.getTypeAtLocation(node.left)) &&
        !isOwnRecordBinding(node.right)
      ) {
        record(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { findings, files: files.length };
}

describe("prototype-key guard", () => {
  let findings: Finding[] = [];
  let probe: string[] = [];
  beforeAll(() => {
    const all = sweep().findings;
    const probeKey = "lib/import/__prototype_key_probe__.ts::";
    probe = all.filter((f) => f.key.startsWith(probeKey)).map((f) => f.key);
    findings = all.filter((f) => !f.key.startsWith(probeKey));
  }, 120_000);

  it("flags exactly the plain forms in the probe file", () => {
    expect([...probe].sort()).toEqual([...PROBE_EXPECTED].sort());
  });

  it("finds no open-text key on a plain object outside the allowlist", () => {
    const offenders = findings
      .filter((f) => !Object.hasOwn(ALLOWED, f.key))
      .map((f) => f.key.replace("::", `:${f.line}  `));
    expect(offenders).toEqual([]);
  });

  it("keeps no stale allowlist entry", () => {
    const seen = new Set(findings.map((f) => f.key));
    expect(Object.keys(ALLOWED).filter((k) => !seen.has(k))).toEqual([]);
  });
});
