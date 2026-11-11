/**
 * Structural guards for the installed app on a phone — the parts no browser
 * in CI can show, because neither Chromium nor WebKit under Playwright
 * reports a safe-area inset or opens an on-screen keyboard.
 *
 *   1. The authenticated shell takes the status-bar and side insets once,
 *      on its outer wrapper, and no 4rem header band pads itself inside its
 *      own height (which on a phone with a 59 px inset left the top bar a
 *      5 px content box and pushed the logo across its bottom border).
 *   2. The stylesheet carries the rules the shell and the keyboard bridge
 *      depend on.
 *   3. Every form field keeps 16 px type on a touch screen: iOS Safari
 *      zooms the page into a focused field below 16 px, and a width
 *      breakpoint alone (`md:text-sm`) handed 14 px to a phone held sideways
 *      and to every iPad. The small size is allowed only behind
 *      `pointer-fine:`. That holds for the primitives and for every call
 *      site, whose `text-sm` replaces the primitive's size, and for a raw
 *      `<textarea>` styled from a class constant.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/source-files";
import { parse, productionSources, readSrc } from "./helpers/source-metrics";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** Drop `//` and block comments so prose about a class cannot satisfy a check. */
function code(source: string, fileName?: string): string {
  return stripComments(source, fileName);
}

describe("the shell owns the safe area", () => {
  it("the authenticated shell wrapper takes the insets", () => {
    const shell = code(read("src/components/layout/auth-shell.tsx"));
    expect(shell).toMatch(/<div className=\{SHELL_ROOT_CLASS\}>/);
    expect(read("src/components/layout/shell-metrics.ts")).toMatch(
      /SHELL_ROOT_CLASS =\s*"shell-safe-area absolute inset-0 flex flex-col"/,
    );
  });

  it.each([
    "src/components/layout/top-bar.tsx",
    "src/components/insights/coach-panel/conversations-panel.tsx",
    "src/components/day/day-layer.tsx",
  ])("%s pads no header band with the status-bar inset", (path) => {
    const source = code(read(path));
    expect(source).not.toMatch(/paddingTop:\s*"env\(safe-area-inset-top/);
    expect(source).not.toMatch(/\bpt-\[env\(safe-area-inset-top/);
  });

  it("globals.css defines the shell band, the keyboard rules and pointer-fine", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(
      /\.shell-safe-area\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top/,
    );
    expect(css).toMatch(
      /\[data-sheet-side="bottom"\]\s*\{\s*bottom:\s*var\(--keyboard-inset/,
    );
    expect(css).toMatch(
      /html\[data-keyboard="open"\] \[data-keyboard-hide\]\s*\{\s*display:\s*none/,
    );
    expect(css).toMatch(/@custom-variant pointer-fine/);
  });

  it("bottom toasts clear the bar under the same query the bar follows", () => {
    // Sonner's own mobile offset stops at 600 px; the bar shows up to `md`
    // and on a phone held sideways, so the lift keys on `shell-mobile`.
    const css = code(read("src/app/globals.css"), "globals.css");
    expect(css).toMatch(
      /html \[data-sonner-toaster\]\[data-y-position="bottom"\]\s*\{\s*@variant shell-mobile\s*\{\s*bottom:\s*calc\(4rem \+ env\(safe-area-inset-bottom/,
    );
  });

  it("the bottom bar and the Coach button step aside for the keyboard", () => {
    expect(read("src/components/layout/bottom-nav.tsx")).toContain(
      'data-keyboard-hide=""',
    );
    expect(read("src/components/insights/layout-coach-fab.tsx")).toContain(
      'data-keyboard-hide=""',
    );
  });

  it("a bottom sheet on the keyboard drops its home-indicator padding", () => {
    // Standing on the keyboard, the safe-area inset left a ~34 px gap
    // between the sheet's last row and the keys.
    expect(code(read("src/app/globals.css"), "globals.css")).toMatch(
      /@custom-variant keyboard-open \(html\[data-keyboard="open"\] &\);/,
    );
    const sheet = code(read("src/components/ui/responsive-sheet.tsx"));
    const padded = (sheet.match(
      /"[^"]*pb-\[calc\(env\(safe-area-inset-bottom[^"]*"/g,
    ) ?? []) as string[];
    expect(padded.length).toBe(2);
    for (const cls of padded) expect(cls).toMatch(/\bkeyboard-open:pb-4\b/);
  });

  it("those rules sit under the utilities, and the bottom sheet sets no bottom utility", () => {
    // Unlayered, the rules outranked every utility on the same element: a
    // `bg-*` on the shell or a `bottom-*` on a sheet would have been ignored
    // without a trace. In the components layer a utility wins, so the bottom
    // sheet must not carry one that would pin it under the keyboard.
    const css = code(read("src/app/globals.css"), "globals.css");
    const start = css.indexOf("@layer components {");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = css.indexOf("{", start); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const layer = css.slice(start, end);
    expect(layer).toMatch(/\.shell-safe-area\s*\{/);
    expect(layer).toMatch(/\[data-sheet-side="bottom"\]\s*\{\s*bottom:/);
    expect(layer).toMatch(/\[data-keyboard-hide\]\s*\{\s*display:\s*none/);
    expect(layer).toMatch(/\[data-sheet-side="left"\]\s*\{\s*border-left:/);
    // Sonner's own rules are unlayered; the toast lift must stay so.
    expect(layer).not.toMatch(/data-sonner-toaster/);

    const sheet = code(read("src/components/ui/bottom-sheet.tsx"));
    const bottomClass = sheet.match(/BOTTOM_SHEET_CLASS\s*=\s*"([^"]*)"/)?.[1];
    expect(bottomClass).toBeDefined();
    expect(bottomClass).not.toMatch(/(?<![\w-])bottom-/);
  });

  it("the sheet primitives name their side for those rules", () => {
    expect(read("src/components/ui/sheet.tsx")).toMatch(
      /data-sheet-side=\{side\}/,
    );
    expect(read("src/components/ui/bottom-sheet.tsx")).toMatch(
      /data-sheet-side="bottom"/,
    );
  });
});

describe("form fields keep 16 px on a touch screen", () => {
  const FIELDS = [
    "src/components/ui/input.tsx",
    "src/components/ui/textarea.tsx",
    "src/components/ui/native-select.tsx",
    "src/components/ui/date-field.tsx",
    "src/components/ui/time-field.tsx",
  ];

  it.each(FIELDS)(
    "%s sets text-base and shrinks only under a fine pointer",
    (path) => {
      // The field's own box is the class string that draws its border; the
      // rest of the file (a picker's buttons, a caption) is not typed into.
      const boxes = (code(read(path)).match(
        /"[^"]*\bborder-input(?![\w-])[^"]*"/g,
      ) ?? []) as string[];
      expect(boxes.length, `${path} has no field class`).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box).toMatch(/\btext-base\b/);
        // Any sub-16 px size must sit behind `pointer-fine:`; `file:` styles
        // the upload button, not typed text.
        const bare = box.match(
          /(?<![\w:-])(?:(?:sm|md|lg|xl):)?text-(?:xs|sm)(?![\w-])/g,
        );
        expect(bare ?? []).toEqual([]);
      }
    },
  );
});

/** Elements a person types into. */
const FIELD_TAGS = new Set([
  "input",
  "textarea",
  "select",
  "Input",
  "Textarea",
  "PasswordInput",
  "NativeSelect",
]);
/** `type` values of an `<input>` nobody types into. */
const NOT_TYPED = new Set([
  "checkbox",
  "radio",
  "range",
  "file",
  "hidden",
  "color",
  "button",
  "submit",
  "reset",
  "image",
]);
/** A type size under 16 px that is not behind `pointer-fine:`. */
const SMALL_TYPE =
  /(?<![\w:-])(?:(?:sm|md|lg|xl):)?text-(?:2xs|xs|sm)(?![\w-])/g;

/** Every string a `className` expression can produce, constants resolved. */
function classStrings(
  node: ts.Node,
  constants: ReadonlyMap<string, string>,
): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [
        ...classStrings(span.expression, constants),
        span.literal.text,
      ]),
    ];
  }
  if (ts.isIdentifier(node)) {
    const value = constants.get(node.text);
    return value === undefined ? [] : [value];
  }
  const out: string[] = [];
  node.forEachChild((child) => {
    out.push(...classStrings(child, constants));
  });
  return out;
}

/** `rel:line <Tag> class` for each field whose classes go under 16 px. */
function smallFields(
  rel: string,
  text: string,
): {
  fields: number;
  small: string[];
} {
  const sf = parse(rel, text);
  const constants = new Map<string, string>();
  sf.forEachChild((statement) => {
    if (!ts.isVariableStatement(statement)) return;
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        (ts.isStringLiteral(decl.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(decl.initializer))
      ) {
        constants.set(decl.name.text, decl.initializer.text);
      }
    }
  });
  let fields = 0;
  const small: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      FIELD_TAGS.has(node.tagName.getText(sf))
    ) {
      const attribute = (name: string) =>
        node.attributes.properties.find(
          (prop): prop is ts.JsxAttribute =>
            ts.isJsxAttribute(prop) && prop.name.getText(sf) === name,
        );
      const type = attribute("type")?.initializer;
      const typed = !(
        type &&
        ts.isStringLiteral(type) &&
        NOT_TYPED.has(type.text)
      );
      const className = attribute("className")?.initializer;
      if (typed && className) {
        fields += 1;
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        for (const cls of classStrings(className, constants)) {
          for (const match of cls.matchAll(SMALL_TYPE)) {
            small.push(
              `${rel}:${line} <${node.tagName.getText(sf)}> ${match[0]}`,
            );
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return { fields, small };
}

describe("no field call site goes under 16 px on a touch screen", () => {
  /**
   * Call sites still under 16 px, fixed by a change of their own. An entry
   * that stops matching fails, so the list only shrinks.
   */
  const OPEN: Readonly<Record<string, string>> = {
    "components/settings/coach-memory-section.tsx":
      "/settings/coach memory editor",
    "components/settings/access/managed-profile-handover.tsx":
      "read-only handover link field",
    "components/cycle/cycle-settings.tsx": "raw cycle-length number field",
    "components/command-palette/command-palette.tsx":
      "search field shrinks at `md:` without `pointer-fine:`",
  };

  const scan = productionSources()
    .filter((rel) => rel.endsWith(".tsx"))
    .map((rel) => ({ rel, ...smallFields(rel, readSrc(rel)) }));

  it("reads the field call sites (floor)", () => {
    const fields = scan.reduce((sum, file) => sum + file.fields, 0);
    expect(fields).toBeGreaterThan(90);
  });

  it("finds a class constant on a raw field, and spares fine-pointer sizes and checkboxes", () => {
    const { small } = smallFields(
      "probe.tsx",
      [
        'const FIELD_CLASSES = "border-input w-full text-sm";',
        "export const A = () => (",
        "  <>",
        '    <textarea className={cn(FIELD_CLASSES, "min-h-16")} />',
        '    <Textarea className="font-mono sm:pointer-fine:text-xs" />',
        '    <input type="checkbox" className="text-sm" />',
        '    <Input className={`h-9 ${wide ? "md:text-sm" : ""}`} />',
        "  </>",
        ");",
      ].join("\n"),
    );
    expect(small).toEqual([
      "probe.tsx:4 <textarea> text-sm",
      "probe.tsx:7 <Input> md:text-sm",
    ]);
  });

  it("no typed-into field sets a size under 16 px outside a fine pointer", () => {
    const offenders = scan
      .filter((file) => !(file.rel in OPEN))
      .flatMap((file) => file.small);
    expect(offenders).toEqual([]);
  });

  it.each(Object.keys(OPEN))("%s is still open", (rel) => {
    expect(scan.find((file) => file.rel === rel)?.small ?? []).not.toEqual([]);
  });
});
