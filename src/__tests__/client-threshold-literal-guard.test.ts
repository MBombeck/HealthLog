/**
 * Client code holds no threshold or polarity table of its own (v1.43, ios
 * #116 items 3 and 4).
 *
 * Which way a change counts and where a chart's reference lines sit depend on
 * the person: their own target, their age, their sex, their glucose unit. The
 * server resolves both (`src/lib/targets/trend-verdict.ts`,
 * `src/lib/measurements/series-reference-lines.ts`) and publishes them on the
 * dashboard snapshot (`tiles.directions`), the vitals baseline (`direction`),
 * the summary and target reads and the series read. A client that keeps its
 * own copy answers for an imaginary average person: a rising blood pressure
 * painted as a setback for someone below their target, a 140 mmHg line on a
 * chart whose person has a band of 115 to 125.
 *
 * Four shapes are refused in client code (`src/components`, `src/hooks`, and
 * every `"use client"` module under `src/app` outside the API):
 *
 *   1. a `directionSentiment` given as a string literal: the tile must read
 *      the resolved verdict;
 *   2. a `ReferenceLine` / `ReferenceArea` drawn at a number literal: a line
 *      has to come from data the server resolved;
 *   3. a polarity table, i.e. a map or set of metric names to `up-good` /
 *      `up-bad`, or a `…Sentiment(type)` function deciding one;
 *   4. an import of the server's resolvers into the browser (a type import
 *      is fine).
 *
 * The guard cannot pass by reading nothing: the walk carries a floor, every
 * rule's matcher is proven against a sample of the shape it exists to catch,
 * every allowlist entry must still match with its exact count, and the rules
 * must see at least one real match across the tree.
 *
 * Its limit: it reads the source, not the running page. A polarity computed
 * from a variable that happens to hold a literal is not seen; review catches
 * that.
 */
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = process.cwd();

interface ClientFile {
  rel: string;
  source: string;
}

function isClientModule(rel: string, source: string): boolean {
  if (rel.startsWith("src/components/") || rel.startsWith("src/hooks/")) {
    return true;
  }
  return /^\s*["']use client["']/.test(stripComments(source).trimStart());
}

function clientFiles(): ClientFile[] {
  const roots: Array<{ dir: string; floor: number }> = [
    { dir: "src/components", floor: 900 },
    { dir: "src/hooks", floor: 50 },
    { dir: "src/app", floor: 900 },
  ];
  const out: ClientFile[] = [];
  for (const { dir, floor } of roots) {
    for (const file of walkSourceFiles(join(ROOT, dir), { floor })) {
      const rel = `${dir}/${file}`;
      if (rel.startsWith("src/app/api/")) continue;
      if (rel.includes("/__tests__/") || /\.test\.tsx?$/.test(rel)) continue;
      const source = readSourceText(join(ROOT, rel));
      if (!isClientModule(rel, source)) continue;
      out.push({ rel, source });
    }
  }
  return out;
}

const parsed = new Map<string, ts.SourceFile>();

/** One parse per file and source, however many rules read it. */
function parse(name: string, source: string): ts.SourceFile {
  const key = `${name}\0${source}`;
  let file = parsed.get(key);
  if (file === undefined) {
    file = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(key, file);
  }
  return file;
}

/** The literal text a JSX attribute initialiser carries, if it is one. */
function literalOf(init: ts.JsxAttributeValue | undefined): string | null {
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      return e.text;
    }
    if (ts.isNumericLiteral(e)) return e.text;
    if (
      ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(e.operand)
    ) {
      return `-${e.operand.text}`;
    }
  }
  return null;
}

function jsxAttributes(
  file: ts.SourceFile,
  visit: (
    tag: string,
    name: string,
    init: ts.JsxAttributeValue | undefined,
    node: ts.Node,
  ) => void,
): void {
  const walk = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(file);
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        visit(tag, attr.name.getText(file), attr.initializer, attr);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** Rule 1 — `directionSentiment` given as a literal. */
function literalDirections(name: string, source: string): string[] {
  const file = parse(name, source);
  const hits: string[] = [];
  jsxAttributes(file, (tag, attr, init, node) => {
    if (attr !== "directionSentiment") return;
    const literal = literalOf(init);
    if (literal !== null) {
      hits.push(
        `${name}:${lineOf(file, node)}: <${tag} directionSentiment="${literal}">`,
      );
    }
  });
  return hits;
}

const LINE_TAGS = new Set(["ReferenceLine", "ReferenceArea"]);
const LINE_ATTRS = new Set(["y", "y1", "y2"]);

/** Rule 2 — a chart reference drawn at a number literal. */
function literalLines(name: string, source: string): string[] {
  const file = parse(name, source);
  const hits: string[] = [];
  jsxAttributes(file, (tag, attr, init, node) => {
    if (!LINE_TAGS.has(tag) || !LINE_ATTRS.has(attr)) return;
    const literal = literalOf(init);
    if (literal !== null && /^-?\d/.test(literal)) {
      hits.push(`${name}:${lineOf(file, node)}: <${tag} ${attr}={${literal}}>`);
    }
  });
  return hits;
}

/** Rule 3 — a polarity table: line-shaped, over comment-stripped code. */
const POLARITY_PATTERNS: RegExp[] = [
  // `RESTING_HEART_RATE: "up-bad"` / `["HRV", "up-good"]`
  /\b[A-Z][A-Z0-9_]{2,}["']?\s*[:,]\s*["']up-(good|bad)["']/,
  // `const UP_BAD_VITALS = new Set([...])`
  /\b(UP_GOOD|UP_BAD)_[A-Z0-9_]+\s*=/,
  // `function vitalSentiment(type: string)`
  /function\s+\w*Sentiment\s*\(\s*(type|metric|kind)\b/,
];
const POLARITY_SAMPLES = [
  'const POLARITY = { RESTING_HEART_RATE: "up-bad" };',
  'new Map([["HEART_RATE_VARIABILITY", "up-good"]])',
  "const UP_BAD_VITALS = new Set(['RESTING_HEART_RATE']);",
  "function vitalSentiment(type: string): TrendDirectionSentiment {",
];

function polarityTables(name: string, source: string): string[] {
  const hits: string[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, index) => {
      if (POLARITY_PATTERNS.some((p) => p.test(line))) {
        hits.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    });
  return hits;
}

/** Rule 4 — the server's resolvers, imported into the browser. */
const SERVER_RESOLVERS = [
  "@/lib/targets/trend-verdict",
  "@/lib/measurements/series-reference-lines",
  "@/lib/measurements/series-change",
  "@/lib/personal-records/record-benchmark",
  "@/lib/insights/mood-pattern-cards",
];

function resolverImports(name: string, source: string): string[] {
  const file = parse(name, source);
  const hits: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (!SERVER_RESOLVERS.includes(from)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    hits.push(`${name}:${lineOf(file, statement)}: import from "${from}"`);
  }
  return hits;
}

interface Rule {
  name: string;
  find: (name: string, source: string) => string[];
  /**
   * Text a file must contain for `find` to have anything to report, tested
   * before any parse. Every shape the rule matches carries one of these.
   */
  markers: readonly string[];
  /** Sources that must produce at least one hit, proving the matcher. */
  samples: Array<{ name: string; source: string }>;
  /** File → exact hit count it may have, with the reason. */
  allow: Record<string, { count: number; reason: string }>;
}

const RULES: Rule[] = [
  {
    name: "a literal directionSentiment",
    find: literalDirections,
    markers: ["directionSentiment"],
    samples: [
      {
        name: "sample.tsx",
        source: 'const a = <TrendCard directionSentiment="up-bad" />;',
      },
      {
        name: "sample.tsx",
        source: 'const a = <TrendCard directionSentiment={"up-good"} />;',
      },
    ],
    allow: {
      "src/components/insights/derived/vitals-dashboard.tsx": {
        count: 5,
        reason:
          "the five derived re-frame tiles (six-minute walk, fitness age, vascular age, HRV balance, BMI) colour a figure whose good direction is its definition (a longer walk, a younger vascular age, no judgement on BMI), not a person's target; the per-vital baseline tile reads the server's `direction`",
      },
      "src/components/insights/derived/same-time-tile.tsx": {
        count: 1,
        reason:
          "the hourly same-time tile colours today's running total against the person's own usual curve, where more movement than usual is the definition of ahead, not a target",
      },
    },
  },
  {
    name: "a reference line at a literal",
    find: literalLines,
    markers: [...LINE_TAGS],
    samples: [
      {
        name: "sample.tsx",
        source: 'const a = <ReferenceLine y={140} stroke="red" />;',
      },
      {
        name: "sample.tsx",
        source: "const a = <ReferenceArea y1={70} y2={180} />;",
      },
    ],
    allow: {
      "src/components/charts/medication-compliance-chart.tsx": {
        count: 2,
        reason:
          "the opt-in adherence overlay: an 80 % minimum and the 100 % goal are properties of a share of doses, the same for every person, not a clinical threshold the person's profile moves",
      },
      "src/components/insights/mood/mood-time-of-day-chart.tsx": {
        count: 1,
        reason:
          "the 3.5 line is the green edge of the 1 to 5 mood scale itself (`MOOD_GREEN_MIN`), the same for every person",
      },
      "src/components/insights/mood/mood-weekday-chart.tsx": {
        count: 1,
        reason:
          "the 3.5 line is the green edge of the 1 to 5 mood scale itself (`MOOD_GREEN_MIN`), the same for every person",
      },
    },
  },
  {
    name: "a polarity table",
    find: polarityTables,
    markers: ["up-good", "up-bad", "UP_GOOD_", "UP_BAD_", "Sentiment"],
    samples: POLARITY_SAMPLES.map((source) => ({ name: "sample.ts", source })),
    allow: {},
  },
  {
    name: "a server resolver imported into the browser",
    find: resolverImports,
    markers: SERVER_RESOLVERS,
    samples: [
      {
        name: "sample.ts",
        source:
          'import { resolveTrendVerdict } from "@/lib/targets/trend-verdict";',
      },
    ],
    allow: {},
  },
];

const FILES = clientFiles();

const ruleHits = new Map<Rule, Map<string, string[]>>();

/** Each rule's hits across the client tree, found once per run. */
function hitsFor(rule: Rule): Map<string, string[]> {
  let out = ruleHits.get(rule);
  if (out !== undefined) return out;
  out = new Map<string, string[]>();
  for (const { rel, source } of FILES) {
    if (!rule.markers.some((marker) => source.includes(marker))) continue;
    const hits = rule.find(rel, source);
    if (hits.length > 0) out.set(rel, hits);
  }
  ruleHits.set(rule, out);
  return out;
}

describe("client threshold literal guard", () => {
  it("walks a client tree of the size it expects", () => {
    expect(FILES.length).toBeGreaterThan(700);
  });

  for (const rule of RULES) {
    describe(rule.name, () => {
      it("still catches the shape it exists to catch", () => {
        for (const sample of rule.samples) {
          expect(
            rule.find(sample.name, sample.source).length,
            `no hit on: ${sample.source}`,
          ).toBeGreaterThan(0);
          // The pre-filter has to let every sample through, or it would hide
          // the shape before the matcher saw it.
          expect(
            rule.markers.some((marker) => sample.source.includes(marker)),
            `the markers skip: ${sample.source}`,
          ).toBe(true);
        }
      });

      it("finds none outside its allowlist, and the allowlist exactly", () => {
        const hits = hitsFor(rule);
        const offenders = [...hits.entries()]
          .filter(([rel]) => !(rel in rule.allow))
          .flatMap(([, lines]) => lines);
        expect(
          offenders,
          "client code decides a threshold or a polarity itself. Read the " +
            "server's resolved field instead (`tiles.directions`, `direction`, " +
            "`referenceLines`), or allowlist the file with its reason.",
        ).toEqual([]);
        for (const [rel, { count }] of Object.entries(rule.allow)) {
          expect(
            hits.get(rel)?.length ?? 0,
            `${rel} is allowlisted for exactly ${count} hits`,
          ).toBe(count);
        }
      });
    });
  }

  it("reads a non-empty set of matches across the tree", () => {
    const total = RULES.reduce(
      (sum, rule) =>
        sum + [...hitsFor(rule).values()].reduce((n, l) => n + l.length, 0),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});
