/**
 * @fileoverview ESLint rule — text sizes come from the type scale, and
 * labels are written in sentence case, not set in capitals.
 *
 * The scale is the Tailwind steps plus the one minted micro step,
 * `text-2xs` (0.6875rem, `src/app/globals.css`), for chips and badges. An
 * arbitrary size (`text-[11px]`, `text-[0.8rem]`) is a step nobody else
 * uses, and the tree collected five of them, each a pixel away from a real
 * step. `uppercase` (usually with a `tracking-wide*` beside it) turned every
 * small heading into a shouted micro-label; the labels are sentence case
 * now, and the caps stay on the one place they mean something: the group
 * labels of the navigation.
 *
 * FLAGGED, under `src/components/` and `src/app/` outside test files, in a
 * class string:
 *   (a) an arbitrary font size `text-[<length>]`: a bare number or a number
 *       with `px`, `rem`, `em`, `vw`, `vh` or `%`, also behind a variant
 *       (`md:text-[13px]`) or the `length:` hint;
 *   (b) the `uppercase` utility, also behind a variant (`sm:uppercase`).
 *
 * A class string is a string literal or template chunk inside a
 * `className` / `class` attribute, inside a call to `cn`, `clsx`, `cx`,
 * `cva`, `tv` or `twMerge` (object keys excepted), or the initialiser of a
 * variable whose name contains `class` or is written in SCREAMING_CASE
 * (`const DAY_SECTION_LABEL = "…"`).
 *
 * NOT FLAGGED: arbitrary colours (`text-[var(--x)]`, `text-[#…]`; colour
 * literals are `no-raw-palette-color`'s business), `normal-case`, and
 * `uppercase` in a file named in `allowUppercaseIn` (the nav group labels).
 *
 * Anything not yet moved over is counted per file in the `allow` option. A
 * file with more hits than its number fails, and so does a file with fewer,
 * until the number is lowered or the entry removed: the map only shrinks.
 *
 * WHAT THIS RULE DOES NOT CATCH
 *
 * A class string built in another way (a lowercase `const label = "…"`
 * passed into `className` later, a string assembled by concatenation), an
 * inline `style={{ fontSize: … }}` or `textTransform`, and capitals typed
 * into the translation strings themselves.
 */

"use strict";

const ENFORCED_ROOTS = ["src/components/", "src/app/"];

const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "cva", "tv", "twMerge"]);
const ARBITRARY_SIZE =
  /^(?:[^\s:]+:)*!?text-\[(?:length:)?-?\d*\.?\d+(?:px|rem|em|vw|vh|%)?\]$/;
const UPPERCASE = /^(?:[^\s:]+:)*!?uppercase$/;

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

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

function isClassVariable(name) {
  return /class/i.test(name) || /^[A-Z][A-Z0-9_]*$/.test(name);
}

/**
 * Whether a string node sits in a class context. Walks the ancestors from
 * the node outward and stops at the first context that decides.
 */
function inClassContext(node, ancestors) {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const anc = ancestors[i];
    if (anc.type === "Property" && anc.key === child && !anc.computed) {
      return false;
    }
    if (anc.type === "JSXAttribute") {
      return (
        anc.name.type === "JSXIdentifier" &&
        (anc.name.name === "className" || anc.name.name === "class")
      );
    }
    if (anc.type === "CallExpression") {
      const name = calleeName(anc.callee);
      if (name && CLASS_HELPERS.has(name)) return true;
      // Any other call (t("…"), a formatter) ends the class context.
      return false;
    }
    if (anc.type === "VariableDeclarator") {
      return (
        anc.init === child &&
        anc.id.type === "Identifier" &&
        isClassVariable(anc.id.name)
      );
    }
    if (
      anc.type === "FunctionDeclaration" ||
      anc.type === "Program" ||
      anc.type === "JSXElement"
    ) {
      return false;
    }
    child = anc;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Text sizes come from the type scale (no arbitrary text-[…] sizes) and labels are sentence case (no uppercase outside the nav group labels).",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "object",
            additionalProperties: { type: "integer", minimum: 1 },
          },
          allowUppercaseIn: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      arbitrarySize:
        '"{{token}}" is an arbitrary font size. Use a step of the type scale: text-2xs (11 px, chips and badges), text-xs, text-sm, and up (UI standards §2).',
      uppercase:
        '"{{token}}" sets the text in capitals. Labels are sentence case; the caps belong to the nav group labels alone. Drop it, and the tracking-wide* that came with it.',
      staleAllow:
        "This file has {{found}} type-scale hit(s) and an allowance of {{allowed}}. Lower the number in the rule's `allow` map in eslint.config.mjs, or remove the entry.",
    },
  },
  create(context) {
    const filename = toPosix(context.filename ?? context.getFilename?.() ?? "");
    if (!ENFORCED_ROOTS.some((root) => filename.includes(root))) return {};
    if (isTestFile(filename)) return {};

    const options = context.options[0] || {};
    const allow = options.allow || {};
    const entry = Object.keys(allow).find((suffix) =>
      filename.endsWith(suffix),
    );
    const allowed = entry ? allow[entry] : 0;
    const uppercaseAllowed = (options.allowUppercaseIn || []).some((suffix) =>
      filename.endsWith(suffix),
    );
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    const hits = [];

    function check(node, text) {
      if (!text || !inClassContext(node, sourceCode.getAncestors(node))) {
        return;
      }
      for (const token of text.split(/\s+/)) {
        if (!token) continue;
        if (ARBITRARY_SIZE.test(token)) {
          hits.push({ node, messageId: "arbitrarySize", token });
        } else if (!uppercaseAllowed && UPPERCASE.test(token)) {
          hits.push({ node, messageId: "uppercase", token });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
      "Program:exit"(program) {
        if (hits.length > allowed) {
          for (const hit of hits.slice(allowed)) {
            context.report({
              node: hit.node,
              messageId: hit.messageId,
              data: { token: hit.token },
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
