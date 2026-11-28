/**
 * A dialog's or a sheet's actions are at most two buttons (`ui/action-pair.tsx`).
 *
 * The measurement sheet carried four controls in its footer and pushed "Save"
 * out of a 448 px dialog; the mood sheet, the cycle day and the targets each
 * had a third button, and every footer laid its buttons out its own way. The
 * footers now lay their children out through `ActionPair` (equal width, at
 * the right edge), and anything beyond the pair goes into its `ActionMenu`.
 *
 * What is read, with the TypeScript parser:
 * - every `footer={…}` handed to a `ResponsiveSheet`;
 * - the children of every `DialogFooter`, `SheetFooter`, `AlertDialogFooter`
 *   and `ActionPair`.
 *
 * In each, a button (`Button`, `AlertDialogAction`, `AlertDialogCancel`,
 * anything named `…Button`, a plain `<button>`) counts one, an `ActionMenu`
 * counts none, and a condition counts its larger branch: `a ? <X/> : <Y/>`
 * is one button, not two. A footer may hold at most two.
 *
 * A wrapper `<div>` around the buttons is refused as well: the footer can no
 * longer lay them out, which is how the old footers each grew their own row.
 * The one `<div>` a footer may hold is an empty portal host with a `ref`,
 * into which a form renders its own `ActionPair`.
 */
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const FOOTER_ELEMENTS = new Set([
  "DialogFooter",
  "SheetFooter",
  "AlertDialogFooter",
  "ActionPair",
]);
const FOOTER_PROP_OWNERS = new Set(["ResponsiveSheet"]);
const BUTTON =
  /^(button|Button|AlertDialogAction|AlertDialogCancel|\w+Button)$/;

interface Finding {
  where: string;
  buttons: number;
  wrapper: boolean;
}

function tagOf(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText(sf);
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText(sf);
  return null;
}

function attributes(node: ts.Node): ts.JsxAttributes | null {
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  return null;
}

function hasAttribute(node: ts.Node, name: string, sf: ts.SourceFile) {
  return (attributes(node)?.properties ?? []).some(
    (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === name,
  );
}

/** How many buttons `node` renders at most, and whether it wraps them. */
function measure(
  node: ts.Node,
  sf: ts.SourceFile,
  root: boolean,
): { buttons: number; wrapper: boolean } {
  if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) {
    return node.expression
      ? measure(node.expression, sf, root)
      : { buttons: 0, wrapper: false };
  }
  if (ts.isConditionalExpression(node)) {
    const a = measure(node.whenTrue, sf, root);
    const b = measure(node.whenFalse, sf, root);
    return {
      buttons: Math.max(a.buttons, b.buttons),
      wrapper: a.wrapper || b.wrapper,
    };
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return measure(node.right, sf, root);
  }
  const tag = tagOf(node, sf);
  if (tag !== null) {
    if (tag === "ActionMenu") return { buttons: 0, wrapper: false };
    if (BUTTON.test(tag)) return { buttons: 1, wrapper: false };
    if (tag === "div" && root) {
      if (ts.isJsxSelfClosingElement(node)) {
        return { buttons: 0, wrapper: !hasAttribute(node, "ref", sf) };
      }
      if (ts.isJsxElement(node)) {
        return { buttons: children(node, sf, false).buttons, wrapper: true };
      }
    }
    if (ts.isJsxSelfClosingElement(node)) return { buttons: 0, wrapper: false };
  }
  if (ts.isJsxFragment(node) || (tag !== null && ts.isJsxElement(node))) {
    // A fragment is transparent: its children stand where it stands.
    const childRoot = ts.isJsxFragment(node) ? root : false;
    let buttons = 0;
    let wrapper = false;
    for (const child of node.children) {
      const m = measure(child, sf, childRoot);
      buttons += m.buttons;
      wrapper ||= m.wrapper;
    }
    return { buttons, wrapper };
  }
  return { buttons: 0, wrapper: false };
}

function children(node: ts.JsxElement, sf: ts.SourceFile, root: boolean) {
  let buttons = 0;
  let wrapper = false;
  for (const child of node.children) {
    const m = measure(child, sf, root);
    buttons += m.buttons;
    wrapper ||= m.wrapper;
  }
  return { buttons, wrapper };
}

function scanFooters(rel: string, text: string): Finding[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];
  const line = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    const tag = tagOf(node, sf);
    if (tag && FOOTER_ELEMENTS.has(tag) && ts.isJsxElement(node)) {
      // `ActionPair` is the layout itself: a host div inside it is not the
      // footer's root, a wrapper is.
      const m = children(node, sf, true);
      found.push({ where: `${rel}:${line(node)} <${tag}>`, ...m });
    }
    if (tag && FOOTER_PROP_OWNERS.has(tag)) {
      for (const prop of attributes(node)?.properties ?? []) {
        if (
          ts.isJsxAttribute(prop) &&
          prop.name.getText(sf) === "footer" &&
          prop.initializer
        ) {
          const m = measure(prop.initializer, sf, true);
          found.push({ where: `${rel}:${line(prop)} footer=`, ...m });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function sweep(): Finding[] {
  const found: Finding[] = [];
  for (const rel of walkSourceFiles(SRC, {
    floor: 1200,
    extensions: [".tsx"],
  })) {
    if (rel.includes("__tests__/") || rel.startsWith("generated/")) continue;
    const text = readSourceText(join(SRC, rel));
    if (
      !/<(DialogFooter|SheetFooter|AlertDialogFooter|ActionPair)\b|\bfooter=\{/.test(
        text,
      )
    ) {
      continue;
    }
    found.push(...scanFooters(rel, text));
  }
  return found;
}

describe("dialog and sheet footers hold at most two buttons", () => {
  it("counts the shapes it guards (the scanner is not blind)", () => {
    const three = `<ResponsiveSheet footer={<><Button/>{x ? <Button/> : null}<Button/></>} />`;
    expect(scanFooters("a.tsx", three)[0].buttons).toBe(3);
    const branches = `<DialogFooter>{a ? <><Button/><Button/></> : <Button/>}</DialogFooter>`;
    expect(scanFooters("b.tsx", branches)[0].buttons).toBe(2);
    const menu = `<ActionPair><ActionMenu><Item/></ActionMenu><Button/><Button/></ActionPair>`;
    expect(scanFooters("c.tsx", menu)[0].buttons).toBe(2);
    const wrapped = `<ResponsiveSheet footer={<div className="flex"><Button/></div>} />`;
    expect(scanFooters("d.tsx", wrapped)[0].wrapper).toBe(true);
    const host = `<ResponsiveSheet footer={<div ref={setEl} className="flex w-full" />} />`;
    expect(scanFooters("e.tsx", host)[0]).toMatchObject({
      buttons: 0,
      wrapper: false,
    });
  });

  it("holds across every component and page", () => {
    const found = requireFloor("dialog and sheet footers", sweep(), 120);
    const offenders = found
      .filter((f) => f.buttons > 2 || f.wrapper)
      .map(
        (f) =>
          `${f.where}: ${f.buttons} button(s)${f.wrapper ? ", wrapped in a div" : ""}`,
      );
    expect(
      offenders,
      "Keep two buttons, the primary last; put the rest in an ActionMenu. Pass the buttons to the footer directly, not inside a div.",
    ).toEqual([]);
  });
});
