/**
 * A sheet or dialog that has the X in its header gets no second way to close
 * it in its footer (`docs/contributing/ui-standards.md`, "One way to close").
 *
 * The Android pairing sheet showed "Close" beside "New code" in its footer
 * while the X sat in the header above them: two controls doing one thing, and
 * the footer a row taller than its one real action needed. The footer holds
 * actions; the X closes.
 *
 * What is read, with the TypeScript parser:
 * - every `footer={…}` handed to a `ResponsiveSheet` that keeps its X (no
 *   `showCloseButton={false}`);
 * - the children of every `DialogFooter` and `SheetFooter` whose enclosing
 *   `DialogContent` / `SheetContent` in the same file keeps its X (the
 *   primitives paint it by default, so a footer with no enclosing content in
 *   the file counts as having one).
 *
 * In each, a button whose only effect is closing is refused:
 * - a button inside a `DialogClose`, `SheetClose` or `…Primitive.Close`;
 * - a button labelled with a close word (its English text is "Close",
 *   "Done", "Got it", "Dismiss" or "OK") whose `onClick` does nothing but
 *   close: none at all, a handler named like a close (`onClose`,
 *   `onDone`, `decline`, …), or an arrow that only calls such a handler or a
 *   setter with `false` (`() => setOpen(false)`, `() => onOpenChange(false)`).
 *
 * Deliberately left alone, so the line is explicit:
 * - `AlertDialogFooter`: an alert or confirm dialog has no X, so its cancel
 *   is the only way out and stays.
 * - "Cancel" in an edit form: it closes, but it says the draft is dropped,
 *   which the X does not; and a destructive confirm's cancel. Neither label is
 *   a close word.
 * - A button with a close-sounding label that does something else (marks a
 *   task done, saves): its `onClick` is not close-only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const BUTTON = /^(button|Button|\w+Button)$/;
const CLOSE_WRAPPER = /^(DialogClose|SheetClose|\w+\.Close)$/;
const CLOSE_WORD = /^(close|done|got it|dismiss|ok)$/i;
const CLOSE_NAME = /close|dismiss|done|decline|hide/i;

/** Every message key whose English text is a bare close word. */
function closeWordKeys(): Set<string> {
  const en = JSON.parse(
    readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"),
  ) as Record<string, unknown>;
  const keys = new Set<string>();
  const walk = (node: unknown, prefix: string) => {
    if (typeof node === "string") {
      if (CLOSE_WORD.test(node.trim())) keys.add(prefix);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
    }
  };
  walk(en, "");
  return keys;
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

function attribute(
  node: ts.Node,
  name: string,
  sf: ts.SourceFile,
): ts.JsxAttribute | undefined {
  for (const p of attributes(node)?.properties ?? []) {
    if (ts.isJsxAttribute(p) && p.name.getText(sf) === name) return p;
  }
  return undefined;
}

/** `showCloseButton={false}` on the element: it paints no X. */
function dropsX(node: ts.Node, sf: ts.SourceFile): boolean {
  const attr = attribute(node, "showCloseButton", sf);
  if (!attr?.initializer || !ts.isJsxExpression(attr.initializer)) {
    return false;
  }
  return attr.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword;
}

/** A call that only closes: `onClose()`, `setOpen(false)`. */
function closingCall(node: ts.Node, sf: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression.getText(sf);
  if (node.arguments.length === 0) return CLOSE_NAME.test(callee);
  return (
    node.arguments.length === 1 &&
    node.arguments[0].kind === ts.SyntaxKind.FalseKeyword
  );
}

function closeOnlyHandler(
  attr: ts.JsxAttribute | undefined,
  sf: ts.SourceFile,
): boolean {
  if (!attr) return true;
  const init = attr.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
  const expr = init.expression;
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    return CLOSE_NAME.test(expr.getText(sf));
  }
  if (ts.isArrowFunction(expr)) {
    const body = expr.body;
    if (ts.isBlock(body)) {
      return (
        body.statements.length > 0 &&
        body.statements.every(
          (s) => ts.isExpressionStatement(s) && closingCall(s.expression, sf),
        )
      );
    }
    return closingCall(body, sf);
  }
  return false;
}

/** The message key a button's children render, when it is one `t("…")`. */
function labelKey(node: ts.JsxElement, sf: ts.SourceFile): string | null {
  for (const child of node.children) {
    if (!ts.isJsxExpression(child) || !child.expression) continue;
    const e = child.expression;
    if (
      ts.isCallExpression(e) &&
      e.expression.getText(sf) === "t" &&
      e.arguments[0] &&
      ts.isStringLiteralLike(e.arguments[0])
    ) {
      return e.arguments[0].text;
    }
  }
  return null;
}

/** Every close-only button rendered under `node`. */
function closeOnlyButtons(
  node: ts.Node,
  sf: ts.SourceFile,
  keys: Set<string>,
): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    const tag = tagOf(n, sf);
    if (tag && CLOSE_WRAPPER.test(tag)) {
      found.push(n);
      return;
    }
    if (tag && BUTTON.test(tag) && ts.isJsxElement(n)) {
      const key = labelKey(n, sf);
      if (
        key !== null &&
        keys.has(key) &&
        closeOnlyHandler(attribute(n, "onClick", sf), sf)
      ) {
        found.push(n);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const SURFACES = new Set(["ResponsiveSheet", "DialogContent", "SheetContent"]);
const FOOTERS = new Set(["DialogFooter", "SheetFooter"]);

function scan(rel: string, text: string, keys: Set<string>): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const offenders = new Set<string>();
  const line = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const report = (node: ts.Node) => {
    for (const b of closeOnlyButtons(node, sf, keys)) {
      offenders.add(`${rel}:${line(b)}`);
    }
  };
  // `const footer = (…)` handed on as `footer={footer}`.
  const consts = new Map<string, ts.Expression>();
  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  // `x` is the nearest enclosing surface's answer, null outside any.
  const visit = (node: ts.Node, x: boolean | null) => {
    const tag = tagOf(node, sf);
    if (tag && SURFACES.has(tag)) {
      // The whole surface, its body as much as its footer: a "Done" row at
      // the bottom of the body is the same second X.
      if (!dropsX(node, sf)) report(node);
      x = !dropsX(node, sf);
    }
    if (tag === "AlertDialogContent") x = false;
    // A footer handed to a wrapper that passes it on to a sheet (the import
    // cards' `ImportSource`, `DocumentPickerSheet`), or a footer built in a
    // `const` before it reaches the sheet.
    const footer = tag ? attribute(node, "footer", sf) : undefined;
    if (footer?.initializer && !dropsX(node, sf)) {
      report(footer.initializer);
      const init = footer.initializer;
      if (
        ts.isJsxExpression(init) &&
        init.expression &&
        ts.isIdentifier(init.expression)
      ) {
        const decl = consts.get(init.expression.text);
        if (decl) report(decl);
      }
    }
    // A footer component with no surface in the file sits in one the
    // primitives give an X by default.
    if (tag && FOOTERS.has(tag) && x === null) report(node);
    ts.forEachChild(node, (child) => visit(child, x));
  };
  visit(sf, null);
  return [...offenders];
}

function sweep(keys: Set<string>) {
  let read = 0;
  const offenders: string[] = [];
  for (const rel of walkSourceFiles(SRC, {
    floor: 1200,
    extensions: [".tsx"],
  })) {
    if (rel.includes("__tests__/") || rel.startsWith("generated/")) continue;
    const text = readSourceText(join(SRC, rel));
    if (
      !/<(DialogFooter|SheetFooter|ResponsiveSheet|DialogContent|SheetContent)\b|\bfooter=\{/.test(
        text,
      )
    ) {
      continue;
    }
    read += 1;
    offenders.push(...scan(rel, text, keys));
  }
  return { read, offenders };
}

describe("a sheet with an X has no close button in its footer", () => {
  const keys = closeWordKeys();

  it("finds the shapes it guards (the scanner is not blind)", () => {
    expect(keys.has("common.close")).toBe(true);
    const footerProp = `<ResponsiveSheet footer={<><Button onClick={() => onOpenChange(false)}>{t("common.close")}</Button><Button onClick={mint}>{t("x.newCode")}</Button></>} />`;
    expect(scan("a.tsx", footerProp, keys)).toEqual(["a.tsx:1"]);
    const primitive = `<DialogContent><DialogFooter><DialogClose asChild><Button>{t("x.y")}</Button></DialogClose></DialogFooter></DialogContent>`;
    expect(scan("b.tsx", primitive, keys)).toEqual(["b.tsx:1"]);
    const branch = `<ResponsiveSheet footer={readOnly ? <Button onClick={onClose}>{t("common.close")}</Button> : <Button onClick={save}>{t("common.save")}</Button>} />`;
    expect(scan("c.tsx", branch, keys)).toEqual(["c.tsx:1"]);
  });

  it("leaves what is not a second X alone", () => {
    const noX = `<ResponsiveSheet showCloseButton={false} footer={<Button onClick={onClose}>{t("common.close")}</Button>} />`;
    expect(scan("a.tsx", noX, keys)).toEqual([]);
    const alert = `<AlertDialogContent><AlertDialogFooter><AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel></AlertDialogFooter></AlertDialogContent>`;
    expect(scan("b.tsx", alert, keys)).toEqual([]);
    const cancel = `<ResponsiveSheet footer={<><Button onClick={onClose}>{t("common.cancel")}</Button><Button onClick={save}>{t("common.save")}</Button></>} />`;
    expect(scan("c.tsx", cancel, keys)).toEqual([]);
    const realAction = `<ResponsiveSheet footer={<Button onClick={() => markDone(id)}>{t("common.close")}</Button>} />`;
    expect(scan("d.tsx", realAction, keys)).toEqual([]);
  });

  it("holds across every component and page", () => {
    const { read, offenders } = sweep(keys);
    requireFloor(
      "files with a sheet or dialog footer",
      Array.from({ length: read }),
      60,
    );
    expect(
      offenders,
      "The header X closes the sheet. Drop the footer button; a footer holds real actions only, and none at all when nothing is left.",
    ).toEqual([]);
  });
});
