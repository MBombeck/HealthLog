/**
 * A component that can draw nothing owns its own frame.
 *
 * "Since the last visit" returns null when it has nothing to list, and the
 * visits section drew the card around it. Every time the component stood
 * down (still loading, a quiet window, a failed read) an empty bordered card
 * stayed on screen under the next appointment (#1241). The fix moved the card
 * into the component; this guard keeps the shape from coming back elsewhere.
 *
 * Scope: every `.tsx` under `src/components` and `src/app` (tests excluded).
 * A finding is a frame (`Card`, `CardContent`, `CardFooter`, or an intrinsic
 * element whose class draws a border, a card background, a rounded box, a
 * shadow or padding) whose only content, through nested frames, is either
 * one component that returns null at its own top level, or one element
 * behind a condition (`{x && <C />}`, `{x ? <C /> : null}`). Such a frame is
 * empty whenever the child stands down or the condition fails. The second
 * shape is reported as `Frame > {cond} > C`, whatever C is: the condition
 * alone is enough to empty the frame.
 *
 * The cases below allow a finding only when the parent already refuses to
 * render the frame on the same condition the child gates on; the reason says
 * which. The list cannot rot quietly: a new finding fails the second case,
 * an entry that no longer matches fails the third, and the fourth runs the
 * detector over a planted example so a sweep that finds nothing cannot pass
 * by accident.
 *
 * The matching is by component name, so two components sharing a name are
 * one entry here. It is a review aid with a structural floor, not a proof.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const SCOPES = ["components/", "app/"];

const FRAME_COMPONENT = /^(Card|CardContent|CardFooter)$/;
const FRAME_CLASS =
  /\b(border|bg-card|rounded-(?:lg|xl|2xl)|shadow(?:-\w+)?|p-\d+|px-\d+|py-\d+)\b/;

/** `file > Frame > Child` → why the frame can never be drawn empty. */
const ALLOWED: Record<string, string> = {
  "components/insights/mood/mood-insights-sections.tsx > CardContent > MoodBetterDays":
    "The section returns null when `betterDays` is empty before drawing the card, the same condition the child gates on.",
  "components/insights/metric-stat-strip.tsx > Card > SeriesBlock":
    "The strip returns null on `!summary || summary.count <= 0` before drawing the card, the same condition the child gates on.",
  "components/insights/metric-stat-strip.tsx > CardContent > SeriesBlock":
    "Same card as the entry above.",
  "components/settings/ai/ai-usage-card.tsx > span > {cond} > span":
    "The bordered ring is the radio control itself and the dot inside marks the checked option; an empty ring is the unchecked look, not an empty frame.",
};

function returnsNullAtTopLevel(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    // A nested function's `return null` is that function's, not the
    // component's.
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const e = node.expression;
      if (e.kind === ts.SyntaxKind.NullKeyword) found = true;
      if (
        ts.isConditionalExpression(e) &&
        (e.whenTrue.kind === ts.SyntaxKind.NullKeyword ||
          e.whenFalse.kind === ts.SyntaxKind.NullKeyword)
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

/** Component names (capitalised) whose own body can return null. */
function selfGatingComponents(sources: ts.SourceFile[]): Set<string> {
  const names = new Set<string>();
  for (const sf of sources) {
    ts.forEachChild(sf, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        if (/^[A-Z]/.test(node.name.text) && returnsNullAtTopLevel(node.body))
          names.add(node.name.text);
      }
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          const init = d.initializer;
          if (
            ts.isIdentifier(d.name) &&
            /^[A-Z]/.test(d.name.text) &&
            init &&
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            ts.isBlock(init.body) &&
            returnsNullAtTopLevel(init.body)
          ) {
            names.add(d.name.text);
          }
        }
      }
    });
  }
  return names;
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function tagOf(node: JsxNode): string {
  return (
    ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName
  ).getText();
}

function classOf(node: JsxNode): string {
  const attrs = (ts.isJsxElement(node) ? node.openingElement : node).attributes
    .properties;
  for (const a of attrs) {
    if (ts.isJsxAttribute(a) && a.name.getText() === "className") {
      return a.initializer?.getText() ?? "";
    }
  }
  return "";
}

function isFrame(node: JsxNode): boolean {
  const tag = tagOf(node);
  if (FRAME_COMPONENT.test(tag)) return true;
  return /^[a-z]/.test(tag) && FRAME_CLASS.test(classOf(node));
}

function unparenthesised(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) ? unparenthesised(e.expression) : e;
}

function asJsx(e: ts.Expression): JsxNode | null {
  const inner = unparenthesised(e);
  return ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner)
    ? inner
    : null;
}

/** The element behind `{x && <C />}` or `{x ? <C /> : null}`, or null. */
function conditionalElement(e: ts.Expression): JsxNode | null {
  const inner = unparenthesised(e);
  if (
    ts.isBinaryExpression(inner) &&
    inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return asJsx(inner.right);
  }
  if (ts.isConditionalExpression(inner)) {
    const isNull = (x: ts.Expression) =>
      unparenthesised(x).kind === ts.SyntaxKind.NullKeyword;
    if (isNull(inner.whenFalse)) return asJsx(inner.whenTrue);
    if (isNull(inner.whenTrue)) return asJsx(inner.whenFalse);
  }
  return null;
}

interface Content {
  node: JsxNode;
  /** Reached through a condition that, when false, leaves nothing. */
  conditional: boolean;
}

/** The one element a frame holds, through nested frames, or null. */
function soleContent(node: ts.JsxElement, conditional = false): Content | null {
  const kids = node.children.filter(
    (c) =>
      !(ts.isJsxText(c) && c.getText().trim() === "") &&
      !(ts.isJsxExpression(c) && !c.expression),
  );
  if (kids.length !== 1) return null;
  const [kid] = kids;
  if (ts.isJsxSelfClosingElement(kid)) return { node: kid, conditional };
  if (ts.isJsxElement(kid)) {
    return isFrame(kid)
      ? soleContent(kid, conditional)
      : { node: kid, conditional };
  }
  if (ts.isJsxExpression(kid) && kid.expression) {
    const el = conditionalElement(kid.expression);
    if (!el) return null;
    if (ts.isJsxElement(el) && isFrame(el)) {
      // A frame behind the condition is gone with it; look inside it for
      // what it frames.
      return soleContent(el, true) ?? { node: el, conditional: true };
    }
    return { node: el, conditional: true };
  }
  return null;
}

function findings(
  files: Array<{ rel: string; source: string }>,
  gating?: Set<string>,
): string[] {
  const sources = files.map((f) =>
    ts.createSourceFile(
      f.rel,
      f.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
  );
  const nullers = gating ?? selfGatingComponents(sources);
  const out: string[] = [];
  for (const sf of sources) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && isFrame(node)) {
        const inner = soleContent(node);
        if (inner?.conditional) {
          out.push(
            `${sf.fileName} > ${tagOf(node)} > {cond} > ${tagOf(inner.node)}`,
          );
        } else if (inner && nullers.has(tagOf(inner.node))) {
          out.push(`${sf.fileName} > ${tagOf(node)} > ${tagOf(inner.node)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...new Set(out)].sort();
}

function sweep(): string[] {
  const files = walkSourceFiles(SRC, { floor: 1200, extensions: [".tsx"] })
    .filter((rel) => SCOPES.some((s) => rel.startsWith(s)))
    .filter((rel) => !rel.includes("__tests__/"))
    .map((rel) => ({ rel, source: readFileSync(join(SRC, rel), "utf8") }));
  expect(files.length).toBeGreaterThan(800);
  return findings(files);
}

describe("self-gating child frame guard", () => {
  const found = sweep();

  it("finds the allowed frames, so the sweep reads the tree it claims to", () => {
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(ALLOWED).length);
  });

  it("draws no frame around a component that can draw nothing", () => {
    const unlisted = found.filter((f) => !(f in ALLOWED));
    expect(
      unlisted,
      "Move the frame into the child (it renders its own card, and none when it has nothing), or guard the frame on the child's own condition and list it in ALLOWED with the reason.",
    ).toEqual([]);
  });

  it("has no stale allowance", () => {
    const stale = Object.keys(ALLOWED).filter((key) => !found.includes(key));
    expect(stale).toEqual([]);
  });

  it("catches the shape #1241 had", () => {
    const planted = `
      function Since({ rows }: { rows: string[] }) {
        if (rows.length === 0) return null;
        return <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
      }
      export function Visits() {
        return (
          <Card className="gap-3">
            <CardContent>
              <Since rows={[]} />
            </CardContent>
          </Card>
        );
      }
    `;
    expect(findings([{ rel: "planted.tsx", source: planted }])).toEqual([
      "planted.tsx > Card > Since",
      "planted.tsx > CardContent > Since",
    ]);
  });

  it("catches a frame whose only content sits behind a condition", () => {
    const planted = `
      export function Tile({ can, rows }: { can: boolean; rows: string[] }) {
        return (
          <>
            <Card>
              <CardContent>{can && <Button>Start</Button>}</CardContent>
            </Card>
            <div className="rounded-lg border p-3">
              {rows.length > 0 ? <ul>{rows}</ul> : null}
            </div>
            <div className="border p-3">
              {can ? <span>Yes</span> : <span>No</span>}
            </div>
          </>
        );
      }
    `;
    expect(findings([{ rel: "planted.tsx", source: planted }])).toEqual([
      "planted.tsx > Card > {cond} > Button",
      "planted.tsx > CardContent > {cond} > Button",
      "planted.tsx > div > {cond} > ul",
    ]);
  });

  it("does not count a frame that holds the condition beside other content", () => {
    const planted = `
      export function Tile({ can }: { can: boolean }) {
        return (
          <Card>
            <CardHeader>Title</CardHeader>
            {can && <CardContent><Button>Start</Button></CardContent>}
          </Card>
        );
      }
    `;
    expect(findings([{ rel: "planted.tsx", source: planted }])).toEqual([]);
  });
});
