/**
 * @fileoverview ESLint rule — explanatory text inside a card stands in the
 * sanctioned hint element, not in a free muted paragraph.
 *
 * Every route has a budget for how much explaining it may do. The budget
 * can only be counted where the explaining happens in one recognisable
 * element: `InfoPopover` (the "i" beside a title) or the shared hint slot of
 * the card primitives. A muted `<p>` with a translated sentence, dropped into
 * the body of a card, is the same explanation in a shape nothing counts, and
 * it is how a card grows three paragraphs of preamble one pull request at a
 * time.
 *
 * FLAGGED, under `src/components/` and `src/app/` outside
 * `src/components/ui/` and test files: a `<p>` or `<span>` whose `className`
 * carries `text-muted-foreground` (a string literal, a template literal, or
 * the string arguments of `cn(…)` and friends) and that has a `{t("…")}`
 * expression among its direct children, when it is lexically nested inside
 * a card element: `Card`, `CardContent`, `CardHeader`, `CardFooter`,
 * `SettingsCard`, `SettingsCardContent`, `InsightSectionCard`, `ListGroup`,
 * or any element whose name ends in `Card`.
 *
 * NOT FLAGGED: the same paragraph outside a card; a muted element whose
 * children are data (a number, a date, a name) rather than a `t()` call;
 * anything inside `InfoPopover` or `FieldInfo`, which are the hint elements;
 * anything passed through a prop slot (`status={…}`, `description={…}`) of
 * the element inside the card, because the slot's owner places that text;
 * the card primitives themselves under `src/components/ui/`.
 *
 * The paragraphs not yet moved over are counted per file in the `allow`
 * option. A file with more than its number fails, and so does a file with
 * fewer, until the number is lowered or the entry removed: the map only
 * shrinks.
 *
 * WHAT THIS RULE DOES NOT CATCH
 *
 * A paragraph whose text arrives through a variable (`{hint}`) or a nested
 * element (`<p><span>{t(…)}</span></p>` reports the span, not the p); a card
 * rendered by a component in another file, so the `<p>` sits in a
 * component that is only placed inside a card at its call site; muted
 * styling applied through a variable rather than an inline class string; a
 * `<div>` used as a paragraph.
 */

"use strict";

const ENFORCED_ROOTS = ["src/components/", "src/app/"];
const EXEMPT_ROOTS = ["src/components/ui/"];

const TEXT_ELEMENTS = new Set(["p", "span"]);
const CARD_NAMES = new Set([
  "Card",
  "CardContent",
  "CardHeader",
  "CardFooter",
  "SettingsCard",
  "SettingsCardContent",
  "InsightSectionCard",
  "ListGroup",
]);
const HINT_NAMES = new Set(["InfoPopover", "FieldInfo"]);
const MUTED = /(?:^|\s)text-muted-foreground(?:\s|$)/;

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function elementName(nameNode) {
  if (!nameNode) return null;
  if (nameNode.type === "JSXIdentifier") return nameNode.name;
  if (nameNode.type === "JSXMemberExpression") {
    return elementName(nameNode.property);
  }
  return null;
}

function isCardName(name) {
  return !!name && (CARD_NAMES.has(name) || /Card$/.test(name));
}

/**
 * Collect every static string reachable inside the className attribute
 * value: plain literals, template chunks, and the arguments of helper
 * calls (`cn(…)`, `clsx(…)`), conditionals and logical fallbacks.
 */
function collectStrings(node, out) {
  if (!node) return;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") out.push(node.value);
      return;
    case "TemplateLiteral":
      for (const quasi of node.quasis) {
        out.push(quasi.value.cooked ?? quasi.value.raw);
      }
      for (const expr of node.expressions) collectStrings(expr, out);
      return;
    case "CallExpression":
      for (const arg of node.arguments) collectStrings(arg, out);
      return;
    case "ConditionalExpression":
      collectStrings(node.consequent, out);
      collectStrings(node.alternate, out);
      return;
    case "LogicalExpression":
      collectStrings(node.left, out);
      collectStrings(node.right, out);
      return;
    case "ArrayExpression":
      for (const el of node.elements) collectStrings(el, out);
      return;
    case "JSXExpressionContainer":
      collectStrings(node.expression, out);
      return;
    default:
      return;
  }
}

function isTranslateCall(expr) {
  return (
    !!expr &&
    expr.type === "CallExpression" &&
    expr.callee.type === "Identifier" &&
    expr.callee.name === "t"
  );
}

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Explanatory text inside a card belongs in the sanctioned hint element, not in a free muted paragraph.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "object",
            additionalProperties: { type: "integer", minimum: 1 },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      freeHint:
        "A muted <{{element}}> with translated text inside <{{card}}>. Explanatory text belongs in the sanctioned hint element (InfoPopover or the shared hint slot of the card) so it counts against the per-route explainer budget; content stays in foreground text.",
      staleAllow:
        "This file has {{found}} free hint paragraph(s) inside cards and an allowance of {{allowed}}. Lower the number in the rule's `allow` map in eslint.config.mjs, or remove the entry.",
    },
  },
  create(context) {
    const filename = toPosix(context.filename ?? context.getFilename?.() ?? "");
    if (!ENFORCED_ROOTS.some((root) => filename.includes(root))) return {};
    if (EXEMPT_ROOTS.some((root) => filename.includes(root))) return {};
    if (isTestFile(filename)) return {};

    const allow = (context.options[0] && context.options[0].allow) || {};
    const entry = Object.keys(allow).find((suffix) =>
      filename.endsWith(suffix),
    );
    const allowed = entry ? allow[entry] : 0;
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    const hits = [];

    return {
      JSXElement(node) {
        const name = elementName(node.openingElement.name);
        if (!TEXT_ELEMENTS.has(name)) return;

        const classAttr = node.openingElement.attributes.find(
          (attr) =>
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === "className",
        );
        if (!classAttr) return;
        const strings = [];
        collectStrings(classAttr.value, strings);
        if (!strings.some((s) => MUTED.test(s))) return;

        const translated = node.children.some(
          (child) =>
            child.type === "JSXExpressionContainer" &&
            isTranslateCall(child.expression),
        );
        if (!translated) return;

        let card = null;
        const ancestors = sourceCode.getAncestors(node);
        for (let i = ancestors.length - 1; i >= 0; i--) {
          const anc = ancestors[i];
          // A prop slot (`status={…}`, `description={…}`): the element that
          // takes the prop owns the text's place, which is the shared slot.
          if (anc.type === "JSXAttribute" && !card) return;
          if (anc.type !== "JSXElement") continue;
          const ancName = elementName(anc.openingElement.name);
          if (HINT_NAMES.has(ancName)) return;
          if (!card && isCardName(ancName)) card = ancName;
        }
        if (!card) return;
        hits.push({ node: node.openingElement, element: name, card });
      },
      "Program:exit"(program) {
        if (hits.length > allowed) {
          for (const hit of hits.slice(allowed)) {
            context.report({
              node: hit.node,
              messageId: "freeHint",
              data: { element: hit.element, card: hit.card },
            });
          }
        } else if (hits.length < allowed) {
          context.report({
            node: program,
            messageId: "staleAllow",
            data: { found: String(hits.length), allowed: String(allowed) },
          });
        }
      },
    };
  },
};
